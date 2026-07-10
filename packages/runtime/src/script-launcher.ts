// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Script launcher, extracted from WorkflowRuntime per the v0.16.0-SOLID
// extension (Wave 2 of the god-decomposition). The runtime holds a
// reference to the `launchScript` function and passes it into
// `RunCompleter` at construction time. The function is testable in
// isolation by constructing a fake `LaunchDeps` object — no
// `WorkflowRuntime` instance required.
//
// Why a module-level function (not a class): the function holds no
// state. Each invocation takes a `deps` bag + the per-run `entry` +
// `script` + `name` + `args` + `jail`. A class would add boilerplate
// without a corresponding benefit (no fields, no state machine).
//
// The 8 collaborators the original inline method touched (agent
// primitive, child workflow primitive, MCP dispatcher, LLM, persistence
// journal, call LLM, phase, log) are now explicit `LaunchDeps`. The
// runtime wires them in the constructor; tests pass fakes.

import { createHash } from "node:crypto"
import { parseMeta } from "./meta.ts"
import { runSandboxed, type SandboxPrimitives } from "./sandbox"
import { getSandboxMemoryMB } from "./constants.ts"
import type { AgentOptions, AgentResult } from "./types.ts"
import type { InternalRunEntry } from "./internal-run-entry.ts"
import type { WorkspaceJail } from "./workspace.ts"

/** Suffix appended to every guest script body to auto-invoke `main()`.
 *  Mirrors the pre-SOLID `new Function` pattern. Hoisted to module
 *  scope so V8 string interning is straightforward and per-call
 *  allocation is removed (gen-12 1C). */
export const SCRIPT_SUFFIX =
  "\n;return typeof main === 'function' ? await main() : undefined"

/** Narrow dependency surface the script launcher needs to spin up a
 *  guest sandbox. The runtime injects concrete sub-components and
 *  helpers at construction time; tests pass fakes to exercise
 *  primitive wiring in isolation. */
export interface LaunchDeps {
  /** Spawn a single agent (delegates to `AgentPrimitive`). */
  spawnAgent: (
    entry: InternalRunEntry,
    task: string,
    opts: AgentOptions | undefined,
    occ: Map<string, number>,
  ) => Promise<AgentResult>
  /** Run a parallel fan-out across agent calls. */
  runParallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  /** Run a pipeline of stages over a list of items. */
  runPipeline: <T>(
    items: T[],
    stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>,
  ) => Promise<Array<unknown>>
  /** Spawn a child workflow. */
  spawnChildWorkflow: (
    entry: InternalRunEntry,
    nameOrScript: string,
    childArgs: unknown,
    occ: Map<string, number>,
  ) => Promise<unknown>
  /** Set the current phase (for the journal). */
  setPhase: (entry: InternalRunEntry, title: string) => void
  /** Append a log line to the journal. */
  appendLog: (entry: InternalRunEntry, msg: string) => void
  /** List MCP tools available to the guest. */
  dispatchMcpList: (entry: InternalRunEntry) => Promise<string[]>
  /** Call a host MCP tool by name. */
  dispatchMcpCall: (
    entry: InternalRunEntry,
    name: string,
    args: unknown,
  ) => Promise<unknown>
  /** The sandbox runner. Injected so tests can supply a fake without
   *  mocking the `sandbox` module globally (which would leak to other
   *  test files in the same `bun test` run). */
  runSandboxed: typeof runSandboxed
  /** Wall-clock deadline for a single sandbox invocation. Injected so
   *  tests can use a tiny deadline without depending on the
   *  production constant. */
  deadlineMs: number
}

/** Run a workflow script inside the QuickJS sandbox. Builds the
 *  guest-visible primitives (agent, parallel, pipeline, workflow,
 *  phase, log, read/write/glob/exists, mcpList, mcpCall) from the
 *  injected `LaunchDeps`, derives a deterministic PRNG seed from
 *  the runID, appends the auto-invocation suffix, and hands the
 *  source to `runSandboxed`. Returns whatever the guest returned,
 *  or `null` if the sandbox reported an error (per the
 *  `runSandboxed` contract).
 *
 *  The per-run occurrence counters `occ` and `workflowOcc` are
 *  scoped to this invocation (one set per script run, not per
 *  call) so the same agent prompt within a run gets a fresh
 *  occurrence key. */
export async function launchScript(
  deps: LaunchDeps,
  entry: InternalRunEntry,
  script: string,
  _name: string,
  args: unknown,
  jail: WorkspaceJail,
): Promise<unknown> {
  const parsed = parseMeta(script)
  const body = parsed.ok ? parsed.body : script

  // Per-run occurrence counters (journal dedup keys)
  const occ = new Map<string, number>()
  const workflowOcc = new Map<string, number>()

  // Build primitives — each closure captures `entry`, the per-run
  // occurrence counters, and the jail.
  const primitives: SandboxPrimitives = {
    agent: (task: string, agentOpts?: Record<string, unknown>) =>
      deps.spawnAgent(entry, task, agentOpts as AgentOptions | undefined, occ),
    parallel: <T>(thunks: Array<() => Promise<T>>) => deps.runParallel<T>(thunks),
    pipeline: <T>(
      items: T[],
      ...stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>
    ) => deps.runPipeline<T>(items, stages),
    workflow: (nameOrScript: string, childArgs?: unknown) =>
      deps.spawnChildWorkflow(entry, nameOrScript, childArgs, workflowOcc),
    phase: (title: string) => deps.setPhase(entry, title),
    log: (msg: string) => deps.appendLog(entry, msg),
    readFile: (path: string) => jail.readFile(path),
    writeFile: (path: string, content: string) => jail.writeFile(path, content),
    glob: (pattern: string) => jail.glob(pattern),
    exists: (path: string) => jail.exists(path),
    // MCP bridge: list/call host functions wired into the guest via
    // the sandbox PRELUDE (see sandbox.ts). Each call goes through
    // the per-run McpBridge which enforces the budget + recursion
    // guard (mcp.ts).
    mcpList: () => deps.dispatchMcpList(entry),
    mcpCall: (name: string, args: unknown) =>
      deps.dispatchMcpCall(entry, name, args),
    args,
  }

  // Deterministic seed from runID
  const seed = createHash("sha1").update(entry.runID).digest().readUInt32BE(0)

  // Append auto-invocation of main() — see SCRIPT_SUFFIX (module-scope)
  const source = body + SCRIPT_SUFFIX

  const result = await deps.runSandboxed(source, primitives, {
    // sandbox memory now reads from SFFMC config
    // (workflow.yaml key: `sandboxMemoryMB`). Default 64 MiB matches
    // the pre-fix value.
    memoryMB: getSandboxMemoryMB(),
    deadlineMs: deps.deadlineMs,
    seed,
  })

  // runSandboxed never throws per contract — null means sandbox error
  return result
}
