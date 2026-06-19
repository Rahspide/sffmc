// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import {
  WorkflowPersistence,
  generateRunID,
  computeScriptSha,
  journalKeyBase,
  flushJournalSync,
} from "./persistence.ts"
import { createEventBus } from "./events.ts"
import { parseMeta } from "./meta.ts"
import {
  resolveWorkflow,
  isInlineScript,
} from "./resolve.ts"
import { WorkspaceJail } from "./workspace.ts"
import { runSandboxed, type SandboxPrimitives } from "./sandbox"
import type {
  AgentOptions,
  AgentResult,
  AgentFailureReason,
  WorkflowConfig,
  WorkflowStatus,
  WorkflowStartInput,
  WorkflowStatusOutput,
  WorkflowOutcome,
  RunEntry,
} from "./types.ts"
import {
  DEFAULT_WORKFLOW_CONFIG,
  AgentFailureReason as AFR,
} from "./types.ts"
import { SCRIPT_DEADLINE_MS, DEFAULT_GRACE_PERIOD_MS, DEFAULT_SANDBOX_CONSTRAINTS, MAX_GRACE_PERIOD_MS, getWorkflowConfigSync, getMaxConcurrentAgents, getSandboxMemoryMB } from "./constants.ts"
import { getBuiltin, loadBuiltin } from "./builtin-registry.ts"
import { cpus } from "node:os"
import { type RichPluginContext, createLogger, loadConfig } from "@sffmc/shared";
import { resolveInheritedTools, McpBridge, DEFAULT_MAX_MCP_CALLS, discoverParentTools } from "./mcp.ts";

// ---------------------------------------------------------------------------
// Constants
//
// W10/W11/W12 — these values used to be hardcoded shadows of constants.ts.
// They now read from the SFFMC workflow config (`getWorkflowConfigSync()`)
// so user YAML overrides take effect. The prior hardcoded values (1000 / 16
// or 2*cpus / 8) are preserved as the defaults in DEFAULT_WORKFLOW_EXTENDED_CONFIG.
// ---------------------------------------------------------------------------

const log = createLogger("workflow")
// W11 — global agent-concurrency cap. Prefer the user-configured value from
// `workflow.yaml` (key: `maxConcurrentAgents`); fall back to a CPU-derived
// default `min(16, 2*cpus)` that matches the pre-W11 hardcoded behavior when
// no override is present. We use `!== 16` to detect "user set a non-default
// value" because the config default is 16 — explicit 16 is treated as
// user-set, which produces identical behavior to the default. Called in
// the constructor (not at module init) so a test that mutates the config
// cache via `__setWorkflowConfig()` between constructions picks up the
// updated value.
function resolveMaxConcurrentAgents(): number {
  const cfg = getMaxConcurrentAgents()
  if (cfg !== 16) return cfg
  return Math.min(16, 2 * Math.max(1, cpus().length))
}

/** Marker on errors from STRUCTURAL workflow faults. */
const WORKFLOW_STRUCTURAL_ERROR = "WorkflowStructuralError"

/** Unique sentinel for per-agent timeout race. */
const STRAGGLER_TIMEOUT = Symbol("straggler-timeout")

// ---------------------------------------------------------------------------
// Plugin context type (extends shared with WorkflowConfig constraint)
// ---------------------------------------------------------------------------

export type PluginContext = RichPluginContext & {
  config?: Partial<WorkflowConfig>
}

// ---------------------------------------------------------------------------
// Semaphore (promise-based)
// ---------------------------------------------------------------------------

function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  const release = () => {
    active--
    if (queue.length === 0) return
    const next = queue.shift()
    if (next) next()
  }
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          active++
          fn().then(
            (value) => { release(); resolve(value) },
            (err) => { release(); reject(err) },
          )
        }
        if (active < max) attempt()
        else queue.push(attempt)
      })
    },
    get active() { return active },
    get max() { return max },
  }
}

// ---------------------------------------------------------------------------
// Simple Lock (in-process mutex)
// ---------------------------------------------------------------------------

const lockMap = new Map<string, Promise<void>>()

function acquireLock(key: string): Promise<{ release: () => void }> {
  const prev = lockMap.get(key) ?? Promise.resolve()
  let release: () => void = () => {}
  const next = new Promise<void>((resolve) => { release = resolve })
  lockMap.set(key, prev.then(() => next))
  return prev.then(() => ({
    release: () => {
      release()
      if (lockMap.get(key) === next) lockMap.delete(key)
    },
  }))
}

// ---------------------------------------------------------------------------
// RunEntry (internal)
// ---------------------------------------------------------------------------

interface InternalRunEntry {
  runID: string
  name: string
  status: WorkflowStatus
  running: number
  succeeded: number
  failed: number
  agentCount: number
  agentCountTotal: number  // total over lifecycle (for cap)
  tokensUsed: number
  capWarned: boolean
  currentPhase?: string
  childRunIDs: Set<string>
  startedMs: number
  deadlineMs: number
  // Deferred outcome
  outcomePromise: Promise<WorkflowOutcome>
  resolveOutcome: (outcome: WorkflowOutcome) => void
  // Abort for cancel
  controller: AbortController
  // Journal replay state
  journalResults: Map<string, unknown>
  journalPass: number
  // Config
  cfg: Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number }
  /** Lexical jail root — persisted to DB; restored on resume(). Child workflows
   *  inherit from parent so the whole tree stays in the same directory. */
  workspace?: string
  /** MCP bridge — per-run state for guest MCP calls (budget + recursion guard).
   *  Constructed in `makeEntry` so each run gets an isolated counter. */
  mcpBridge: McpBridge
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface RuntimeOpts {
  /** Optional persistence instance. When omitted, a default on-disk
   *  persistence is created using XDG_DATA_HOME or ~/.local/share. */
  persistence?: WorkflowPersistence
  /** Optional grace period override (ms). When provided, takes precedence
   *  over both the user YAML config and the default. Used by tests to
   *  inject a tighter window without round-tripping through the YAML. */
  gracePeriodMsOverride?: number
  /** W14 — synchronous config override for tests. Skips the async YAML
   *  load. When set, the runtime uses these values for maxSteps / maxTokens /
   *  maxWallClockMs / perStepTimeoutMs in `resolveConfig()`. The SFFMC
   *  extended config (maxDepth, maxLifecycleAgents, maxConcurrentAgents)
   *  is unaffected — use `__setWorkflowConfig()` from constants.ts for
   *  those. */
  configOverride?: Partial<WorkflowConfig>
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  private ctx: PluginContext
  private runs = new Map<string, InternalRunEntry>()
  private globalSem: ReturnType<typeof makeSemaphore>
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private persistence: WorkflowPersistence
  /** Event bus for observability listeners. */
  readonly events = createEventBus()
  /** H5 — grace period in ms, populated by the index.ts config hook
   *  via `loadConfig<WorkflowConfig>("workflow", ...)`. Tests may also
   *  inject a value via `RuntimeOpts.gracePeriodMsOverride`. Stored on
   *  the runtime (not the plugin context) so `recoverOrphanedWorkflows()`
   *  can read it synchronously. */
  private gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS
  /** W14 — SFFMC-loaded workflow config (maxSteps / maxTokens /
   *  maxWallClockMs / perStepTimeoutMs). Populated lazily by
   *  `loadWorkflowConfig()` on the first `start()` or `resume()` call.
   *  Tests inject via `RuntimeOpts.configOverride` (sync, no YAML).
   *  Resolved values: prefer this cache → ctx.config (OpenCode provider) →
   *  DEFAULT_WORKFLOW_CONFIG. */
  private workflowConfig: Required<WorkflowConfig> | null = null
  /** W14 — flag to skip async YAML load when the test override is set. */
  private workflowConfigInjected: boolean = false

  constructor(ctx: PluginContext, opts?: RuntimeOpts) {
    this.ctx = ctx
    // W11 — resolve at constructor time (not module init) so the
    // semaphore respects a config the caller may set via
    // `__setWorkflowConfig()` before constructing the runtime.
    this.globalSem = makeSemaphore(resolveMaxConcurrentAgents())
    this.persistence = opts?.persistence ?? new WorkflowPersistence()
    if (opts?.gracePeriodMsOverride !== undefined) {
      this.setGracePeriodMs(opts.gracePeriodMsOverride)
    }
    if (opts?.configOverride) {
      this.setConfig(opts.configOverride)
    }
  }

  /** H5 — set the grace period at runtime. Used by the index.ts config
   *  hook after `loadConfig` returns. Validates the value (integer,
   *  0..24h) and throws on out-of-range. */
  setGracePeriodMs(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_GRACE_PERIOD_MS) {
      throw new Error(
        `Invalid gracePeriodMs: ${ms} (must be integer 0..${MAX_GRACE_PERIOD_MS})`,
      )
    }
    this.gracePeriodMs = ms
  }

  /** W14 — synchronously inject a workflow config. Used by tests via
   *  `RuntimeOpts.configOverride` to skip the async YAML load. Merges
   *  onto `DEFAULT_WORKFLOW_CONFIG` so missing keys fall back to defaults.
   *  When set, subsequent `loadWorkflowConfig()` calls are no-ops unless
   *  `null` is passed (which re-enables the YAML load). */
  setConfig(cfg: Partial<WorkflowConfig> | null): void {
    if (cfg === null) {
      this.workflowConfig = null
      this.workflowConfigInjected = false
      return
    }
    this.workflowConfig = {
      maxSteps: cfg.maxSteps ?? DEFAULT_WORKFLOW_CONFIG.maxSteps,
      maxTokens: cfg.maxTokens ?? DEFAULT_WORKFLOW_CONFIG.maxTokens,
      maxWallClockMs: cfg.maxWallClockMs ?? DEFAULT_WORKFLOW_CONFIG.maxWallClockMs,
      perStepTimeoutMs: cfg.perStepTimeoutMs ?? DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs,
      gracePeriodMs: cfg.gracePeriodMs ?? DEFAULT_WORKFLOW_CONFIG.gracePeriodMs,
    }
    this.workflowConfigInjected = true
  }

  /** W14 — lazily load the SFFMC workflow config from `workflow.yaml`.
   *  Idempotent — concurrent callers all await the same promise. No-op
   *  when the config was already injected (test override path). Called
   *  eagerly by `start()` / `resume()` before `resolveConfig()` runs. */
  async loadWorkflowConfig(): Promise<void> {
    if (this.workflowConfigInjected) return
    if (this.workflowConfig) return
    const loaded = await loadConfig<typeof DEFAULT_WORKFLOW_CONFIG>(
      "workflow",
      DEFAULT_WORKFLOW_CONFIG,
    )
    this.workflowConfig = {
      maxSteps: loaded.maxSteps ?? DEFAULT_WORKFLOW_CONFIG.maxSteps,
      maxTokens: loaded.maxTokens ?? DEFAULT_WORKFLOW_CONFIG.maxTokens,
      maxWallClockMs: loaded.maxWallClockMs ?? DEFAULT_WORKFLOW_CONFIG.maxWallClockMs,
      perStepTimeoutMs: loaded.perStepTimeoutMs ?? DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs,
      gracePeriodMs: loaded.gracePeriodMs ?? DEFAULT_WORKFLOW_CONFIG.gracePeriodMs,
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(input: WorkflowStartInput & { sessionID?: string; name?: string }): Promise<{ runID: string }> {

    // W14 — lazily load the SFFMC workflow config from `workflow.yaml`
    // before `resolveConfig()` reads it. Idempotent; no-op for tests
    // that injected a config via `RuntimeOpts.configOverride`.
    await this.loadWorkflowConfig()

    // Resolve script
    const script = await this.resolveScript(input)

    const parsed = parseMeta(script)
    if (!parsed.ok) {
      throw new Error(`Workflow script invalid: ${parsed.error}`)
    }

    const name = parsed.meta.name

    // Resolve config
    const cfg = this.resolveConfig()

    // Persist — createRun generates its own runID, use that as ours
    const scriptSha = computeScriptSha(script)
    // Resolve workspace first so it persists alongside the run row (v0.13.0).
    // resume() restores from this column instead of falling back to cwd.
    const workspace = input.workspace ?? process.cwd()
    const runID = this.persistence.createRun(name, name, scriptSha, undefined, workspace)
    await this.persistence.writeScript(runID, script)

    const jail = new WorkspaceJail(workspace)

    // Load journal (empty on fresh run)
    const journal = await this.persistence.loadJournal(runID)

    const entry = this.makeEntry({ runID, name, cfg, journalResults: journal.results, journalPass: journal.pass, workspace })

    this.runs.set(runID, entry)

    // Launch async — sandbox never throws, but defensively handle rejections
    this.settleEntry(entry, script, parsed.meta.name, input.args, jail)

    this.events.emit("workflow:started", { runID, name })
    return { runID }
  }

  async status(input: { runID: string }): Promise<WorkflowStatusOutput> {
    const entry = this.runs.get(input.runID)
    if (!entry) {
      // Try loading from DB
      const row = this.persistence.loadRun(input.runID)
      if (!row) {
        return {
          runID: input.runID,
          status: "crashed",
          agentCount: 0,
          succeeded: 0,
          failed: 0,
          stepsCompleted: 0,
          stepsTotal: 0,
          tokensUsed: 0,
        }
      }
      return {
        runID: row.runID,
        status: row.status,
        agentCount: row.succeeded + row.failed,
        succeeded: row.succeeded,
        failed: row.failed,
        currentPhase: row.currentPhase,
        stepsCompleted: row.succeeded + row.failed,
        stepsTotal: 0,
        tokensUsed: 0,
        error: row.error,
      }
    }
    return {
      runID: entry.runID,
      status: entry.status,
      agentCount: entry.agentCount,
      succeeded: entry.succeeded,
      failed: entry.failed,
      currentPhase: entry.currentPhase,
      stepsCompleted: entry.succeeded + entry.failed,
      stepsTotal: entry.cfg.maxSteps,
      tokensUsed: entry.tokensUsed,
    }
  }

  async wait(input: { runID: string; timeoutMs?: number }): Promise<WorkflowOutcome> {
    const entry = this.runs.get(input.runID)
    if (!entry) {
      return {
        runID: input.runID,
        status: "failed",
        error: `unknown runID ${input.runID}`,
        stepsCompleted: 0,
        stepsTotal: 0,
        tokensUsed: 0,
        durationMs: 0,
      }
    }
    if (input.timeoutMs === undefined) {
      return entry.outcomePromise
    }
    const timeout = new Promise<WorkflowOutcome>((resolve) =>
      setTimeout(() => resolve({
        runID: input.runID,
        status: "failed",
        error: "workflow wait timed out",
        stepsCompleted: entry.succeeded + entry.failed,
        stepsTotal: entry.cfg.maxSteps,
        tokensUsed: entry.tokensUsed,
        durationMs: Date.now() - entry.startedMs,
      }), input.timeoutMs),
    )
    return Promise.race([entry.outcomePromise, timeout])
  }

  async cancel(input: { runID: string }): Promise<void> {
    const entry = this.runs.get(input.runID)
    if (!entry || entry.status !== "running") return
    entry.controller.abort()
    entry.status = "cancelled"
    entry.resolveOutcome(this.outcomeFor(entry, "cancelled"))
    this.persistence.updateRunStatus(entry.runID, "cancelled")
    flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: "cancelled" })
  }

  async list(): Promise<Array<{ runID: string; name: string; status: WorkflowStatus }>> {
    // Combine in-memory and DB rows
    const dbRuns = this.persistence.listRuns()
    const result = new Map<string, { runID: string; name: string; status: WorkflowStatus }>()

    for (const row of dbRuns) {
      result.set(row.runID, { runID: row.runID, name: row.name, status: row.status })
    }
    for (const [id, entry] of this.runs) {
      result.set(id, { runID: id, name: entry.name, status: entry.status })
    }

    return [...result.values()]
  }

  async resume(input: { runID: string; agentTimeoutMs?: number }): Promise<{ runID: string; resumed: boolean }> {
    // W14 — same lazy load as `start()` so resume() picks up the YAML
    // config on first call.
    await this.loadWorkflowConfig()
    const lock = await acquireLock("workflow-resume:" + input.runID)
    try {
      // In-process live guard
      const live = this.runs.get(input.runID)
      if (live && live.status === "running") {
        return { runID: input.runID, resumed: false }
      }

      // Load from DB
      const row = this.persistence.loadRun(input.runID)
      if (!row) return { runID: input.runID, resumed: false }

      // Read script
      const script = await this.persistence.readScript(input.runID)
      if (!script) return { runID: input.runID, resumed: false }

      // Edit detection
      const currentSha = computeScriptSha(script)
      const freshJournal = row.scriptSha !== currentSha
      if (freshJournal) {
        await this.persistence.clearJournal(input.runID)
      }

      // Re-build via start-like flow
      const parsed = parseMeta(script)
      const name = parsed.ok ? parsed.meta.name : row.name

      const cfg = this.resolveConfig(input.agentTimeoutMs ?? row.agentTimeoutMs ?? undefined)

      // Restore the original lexical jail root from the DB (v0.13.0). Pre-v0.13.0
      // rows have workspace=NULL — fall back to cwd with an info log so users
      // notice the legacy behavior (any pre-resume file ops hit cwd, not the
      // original workspace).
      const resumeWorkspace = row.workspace ?? process.cwd()
      if (!row.workspace) {
        log.info(
          `resume(${input.runID}): no workspace persisted (legacy row, pre-v0.13.0); falling back to cwd: ${process.cwd()}`,
        )
      }

      const journal = await this.persistence.loadJournal(input.runID)

      const entry = this.makeEntry({ runID: input.runID, name, cfg, journalResults: journal.results, journalPass: journal.pass, workspace: resumeWorkspace })

      this.runs.set(input.runID, entry)
      this.persistence.updateRunStatus(input.runID, "running")

      this.events.emit("workflow:resumed", { runID: input.runID, name, wasStatus: row.status })

      this.settleEntry(entry, script, name, row.args, new WorkspaceJail(resumeWorkspace))

      return { runID: input.runID, resumed: true }
    } finally {
      lock.release()
    }
  }

  /** Shut down the runtime: cancel all running workflows, clear listeners,
   *  flush timers, and close the persistence database. Safe to call multiple
   *  times. */
  close(): void {
    // Cancel all running workflows
    for (const [, entry] of this.runs) {
      if (entry.status === "running") {
        entry.controller.abort()
        entry.status = "cancelled"
      }
    }
    // Clear event listeners
    this.events.clearAll()
    // Clear flush timers
    for (const [, t] of this.flushTimers) {
      clearTimeout(t)
    }
    this.flushTimers.clear()
    // Close persistence (DB connection)
    this.persistence.close()
  }

  /** Recover orphaned workflows on startup.
   *  Any run left in 'running' status after a process restart is orphaned.
   *  Lock recovery is N/A — lockMap at runtime.ts:100 is in-process only;
   *  there is no on-disk lock. After this method returns, all orphaned
   *  runs are either marked 'paused' (resumable) or 'crashed' (no journal).
   *
   *  H5 — grace period: a row with `time_created` within `gracePeriodMs`
   *  of now is always marked 'paused' (regardless of journal presence);
   *  rows past the grace use the legacy journal-presence check.
   *  See v0.14 design §3.2. */
  async recoverOrphanedWorkflows(): Promise<void> {
    const rows = this.persistence.listRunningRuns()
    const nowMs = Date.now()
    const graceMs = this.gracePeriodMs
    for (const row of rows) {
      // Belt-and-suspenders: in-memory live runs can't be orphaned.
      if (this.runs.has(row.runID)) continue
      const ageMs = nowMs - (row.createdAt * 1000)
      if (ageMs <= graceMs) {
        // Within grace: always paused. User gets to decide.
        this.persistence.updateRunStatus(
          row.runID,
          "paused",
          `Process restarted — within grace period (${Math.round(ageMs)}ms <= ${graceMs}ms); resumable`,
        )
        continue
      }
      const hasJournal = await this.persistence.hasJournalEvents(row.runID)
      if (hasJournal) {
        this.persistence.updateRunStatus(
          row.runID,
          "paused",
          `Process restarted — past grace period (${Math.round(ageMs)}ms > ${graceMs}ms); resumable from journal`,
        )
      } else {
        this.persistence.updateRunStatus(
          row.runID,
          "crashed",
          `Process restarted — past grace period (${Math.round(ageMs)}ms) and no journal to recover`,
        )
      }
    }
    flushJournalSync()
  }

  // ── Private: script resolution ─────────────────────────────────────────

  private async resolveScript(input: WorkflowStartInput & { name?: string }): Promise<string> {
    // Built-in by name
    if (input.name && !input.script) {
      const builtin = getBuiltin(input.name)
      if (builtin) {
        const entry = await loadBuiltin(input.name)
        return entry.script
      }
      // Try saved workflow
      const workspace = input.workspace ?? process.cwd()
      const resolved = await resolveWorkflow(input.name, workspace)
      return resolved.source
    }

    // Inline script
    if (input.script) {
      if (isInlineScript(input.script)) return input.script
    }

    // File path
    if (input.file) {
      // Jail check: file must stay within workspace
      const workspace = input.workspace ?? process.cwd()
      const resolved = path.resolve(workspace, input.file)
      const normalizedResolved = path.resolve(resolved)
      const normalizedWorkspace = path.resolve(workspace)
      if (!normalizedResolved.startsWith(normalizedWorkspace + path.sep) && normalizedResolved !== normalizedWorkspace) {
        throw new Error(`Workflow file escapes workspace: ${JSON.stringify(input.file)}`)
      }
      return readFile(resolved, "utf-8")
    }

    throw new Error("workflow start requires name, script, or file")
  }

  // ── Private: launch ────────────────────────────────────────────────────

  private async launchScript(entry: InternalRunEntry, script: string, name: string, args: unknown, jail: WorkspaceJail): Promise<unknown> {
    const parsed = parseMeta(script)
    const body = parsed.ok ? parsed.body : script

    // Per-run occurrence counters (journal dedup keys)
    const occ = new Map<string, number>()
    const workflowOcc = new Map<string, number>()

    // Build primitives — each closure captures `entry`, counters, and the jail
    const primitives: SandboxPrimitives = {
      agent: (task: string, agentOpts?: Record<string, unknown>) =>
        this.spawnAgent(entry, task, agentOpts as AgentOptions | undefined, occ),
      parallel: <T>(thunks: Array<() => Promise<T>>) => this.runParallel<T>(thunks),
      pipeline: <T>(items: T[], ...stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>) =>
        this.runPipeline<T>(items, stages),
      workflow: (nameOrScript: string, childArgs?: unknown) =>
        this.spawnChildWorkflow(entry, nameOrScript, childArgs, workflowOcc),
      phase: (title: string) => this.setPhase(entry, title),
      log: (msg: string) => this.appendLog(entry, msg),
      readFile: (path: string) => jail.readFile(path),
      writeFile: (path: string, content: string) => jail.writeFile(path, content),
      glob: (pattern: string) => jail.glob(pattern),
      exists: (path: string) => jail.exists(path),
      // MCP bridge: list/call host functions wired into the guest via the
      // sandbox PRELUDE (see sandbox.ts). Each call goes through the per-run
      // McpBridge which enforces the budget + recursion guard (mcp.ts).
      mcpList: () => this.dispatchMcpList(entry),
      mcpCall: (name: string, args: unknown) => this.dispatchMcpCall(entry, name, args),
      args,
    }

    // Deterministic seed from runID
    const seed = createHash("sha1").update(entry.runID).digest().readUInt32BE(0)

    // Append auto-invocation of main() — mirrors the old new Function pattern
    const source = body + "\n;return typeof main === 'function' ? await main() : undefined"

    const result = await runSandboxed(source, primitives, {
      // W13 — sandbox memory now reads from SFFMC config
      // (workflow.yaml key: \`sandboxMemoryMB\`). Default 64 MiB matches
      // the pre-W13 hardcoded value.
      memoryMB: getSandboxMemoryMB(),
      deadlineMs: SCRIPT_DEADLINE_MS, // 12h wall-clock for the sandbox
      seed,
      runID: entry.runID,
    })

    // runSandboxed never throws per contract — null means sandbox error
    return result
  }

  // ── Private: primitives (extracted from launchScript) ───────────────────

  /** agent(task, opts?) — called from inside the sandbox. */
  private async spawnAgent(
    entry: InternalRunEntry,
    task: string,
    opts: AgentOptions | undefined,
    occ: Map<string, number>,
  ): Promise<AgentResult> {
    const o = opts ?? {} as AgentOptions
    const promptStr = String(task)

    // Journal cache lookup
    const base = journalKeyBase(promptStr, {
      agentType: undefined,
      model: o.model,
      schema: o.schema,
      phase: o.phase,
    })
    const n = occ.get(base) ?? 0
    occ.set(base, n + 1)
    const key = base + ":" + n

    if (entry.journalResults.has(key)) {
      entry.succeeded++
      this.scheduleFlush(entry)
      return entry.journalResults.get(key) as AgentResult
    }

    // Run under semaphore
    return this.globalSem.run(async () => {
      // Lifecycle cap
      if (entry.agentCountTotal >= entry.cfg.maxLifecycleAgents) {
        if (!entry.capWarned) {
          entry.capWarned = true
          log.warn(`lifecycle cap ${entry.cfg.maxLifecycleAgents} reached for ${entry.runID}`)
        }
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        return null
      }

      // Token cap
      if (entry.tokensUsed >= entry.cfg.maxTokens) {
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        return null
      }

      // Check maxSteps
      if (entry.succeeded + entry.failed >= entry.cfg.maxSteps) {
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        return null
      }

      // Abort check
      if (entry.controller.signal.aborted) {
        return null
      }

      // Depth check
      const depth = o.depth ?? 0
      if (depth > entry.cfg.maxDepth) {
        throw new Error(`Workflow nesting depth (${depth}) exceeds maxDepth (${entry.cfg.maxDepth})`)
      }

      // Counter invariants: running++ before spawn
      entry.running++
      entry.agentCount++
      entry.agentCountTotal++
      this.scheduleFlush(entry)

      return this.executeAgentCall(entry, promptStr, o, key)
    })
  }

  /** Internal: call LLM and process the result (extracted from spawnAgent to
   *  keep the semaphore/cap-check flow and the LLM execution as separate concerns). */
  private async executeAgentCall(
    entry: InternalRunEntry,
    promptStr: string,
    o: AgentOptions,
    key: string,
  ): Promise<AgentResult | null> {
    let reason: AgentFailureReason = AFR.ActorError
    try {
      const result = await this.callLLM(entry, promptStr, o)

      // Track tokens
      const tokens = result.info?.tokens
      const totalTokens = (tokens?.input ?? 0) + (tokens?.output ?? 0)
      entry.tokensUsed += totalTokens

      // Check token cap
      if (entry.tokensUsed >= entry.cfg.maxTokens) {
        this.events.emit("workflow:step_checkpoint", {
          runID: entry.runID,
          stepIndex: entry.succeeded + entry.failed,
          costTokens: totalTokens,
        })
        this.events.emit("workflow:finished", {
          runID: entry.runID,
          status: "budget_exceeded",
          error: `Token cap ${entry.cfg.maxTokens} exceeded`,
        })
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        entry.running--
        entry.failed++
        this.scheduleFlush(entry)
        return null
      }

      // Extract deliverable
      const deliverable = o.schema
        ? (result.structured ?? null)
        : (result.structured ?? result.finalText ?? null)

      if (deliverable === null) {
        reason = AFR.NoDeliverable
        entry.running--
        entry.failed++
        this.publishAgentFailed(entry.runID, key, reason)
        this.scheduleFlush(entry)
        return null
      }

      entry.running--
      entry.succeeded++
      this.scheduleFlush(entry)

      // Journal successful result
      this.persistence.appendJournalSync(entry.runID, {
        t: "agent",
        key,
        result: deliverable,
        pass: entry.journalPass,
      })

      return deliverable as AgentResult
    } catch (e) {
      reason = AFR.SpawnReject
      entry.running--
      entry.failed++
      this.publishAgentFailed(entry.runID, key, reason)
      this.scheduleFlush(entry)
      return null
    }
  }

  /** parallel(thunks) — Promise.all wrapper. Handled by sandbox PRELUDE, but
   *  provided here as a fallback for direct host invocations. */
  private async runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    const results: Array<T | null> = []
    const promises = thunks.map((thunk) => thunk())
    const settled = await Promise.all(promises)
    for (const r of settled) results.push(r)
    return results
  }

  /** pipeline(items, ...stages) — sequential stages. See runParallel for
   *  same PRELUDE note. */
  private async runPipeline<T>(
    items: T[],
    stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>,
  ): Promise<Array<unknown>> {
    const results: Array<unknown> = []
    for (const item of items) {
      let acc: unknown = item
      for (let i = 0; i < stages.length; i++) {
        acc = await stages[i](acc, item, i)
      }
      results.push(acc)
    }
    return results
  }

  /** workflow(nameOrScript, args?) — spawn a child workflow. */
  private async spawnChildWorkflow(
    entry: InternalRunEntry,
    nameOrScript: string,
    childArgs: unknown,
    workflowOcc: Map<string, number>,
  ): Promise<unknown> {
    const spec = String(nameOrScript)
    const base = createHash("sha256")
      .update(JSON.stringify({ spec, args: childArgs ?? null }))
      .digest("hex")
    const n = workflowOcc.get(base) ?? 0
    workflowOcc.set(base, n + 1)
    const key = "wf:" + base + ":" + n

    // Journal hit
    if (entry.journalResults.has(key)) {
      entry.succeeded++
      this.scheduleFlush(entry)
      return entry.journalResults.get(key)
    }

    // Resolve child script
    let childScript: string
    try {
      const workspace = entry.workspace ?? process.cwd()
      const resolved = isInlineScript(spec)
        ? { source: spec, meta: parseMeta(spec), kind: "inline" as const }
        : await resolveWorkflow(spec, workspace)
      childScript = resolved.source
    } catch (e) {
      throw new Error(`${WORKFLOW_STRUCTURAL_ERROR}: unknown workflow: ${JSON.stringify(spec)}`)
    }

    const childName = isInlineScript(spec) ? "inline:" + base.slice(0, 12) : spec

    // Launch child sub-run
    const childRunID = generateRunID()
    entry.childRunIDs.add(childRunID)

    const childEntry = await this.startChildWorkflow(entry, childScript, childName, childArgs, childRunID)

    // Wait for child outcome
    const childOutcome = await childEntry.outcomePromise

    // Structural errors propagate
    if (childOutcome.status === "failed" && childOutcome.error?.includes(WORKFLOW_STRUCTURAL_ERROR)) {
      const idx = childOutcome.error.indexOf(WORKFLOW_STRUCTURAL_ERROR)
      throw new Error(childOutcome.error.slice(idx))
    }

    // Runtime failure → null
    if (childOutcome.status !== "completed") {
      return null
    }

    const value = childOutcome.result ?? null

    // Journal successful child
    if (value !== null) {
      this.persistence.appendJournalSync(entry.runID, {
        t: "agent",
        key,
        result: value,
        pass: entry.journalPass,
      })
    }

    return value
  }

  /** phase(title) — set the current phase for a run. */
  private setPhase(entry: InternalRunEntry, title: string): void {
    entry.currentPhase = title
    this.persistence.appendJournal(entry.runID, {
      t: "phase",
      title,
      pass: entry.journalPass,
    })
    this.events.emit("workflow:phase", { runID: entry.runID, title })
  }

  /** log(msg) — append a log message to the run journal. */
  private appendLog(entry: InternalRunEntry, msg: string): void {
    this.persistence.appendJournal(entry.runID, {
      t: "log",
      msg,
      pass: entry.journalPass,
    })
    this.events.emit("workflow:log", { runID: entry.runID, message: msg })
  }

  // ── Private: MCP dispatch (per-run) ──────────────────────────────────────
  //
  // Host-side implementations of the guest's `mcp.list()` / `mcp.call()`
  // globals. Each guest call funnels through `entry.mcpBridge` (budget +
  // recursion guard). The actual MCP tool invocation goes through the parent
  // OpenCode SDK (`ctx.client.tool.call`) — when the SDK surface is missing
  // the dispatch fails closed with a typed error, never silently dropping the
  // call (mcp.ts makeMcpPrimitives handles the throw path).

  private async dispatchMcpList(entry: InternalRunEntry): Promise<string[]> {
    const discovered = await discoverParentTools(this.ctx)
    return discovered ?? []
  }

  private async dispatchMcpCall(
    entry: InternalRunEntry,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const bridge = entry.mcpBridge

    // Budget gate (lifecycle cap of MCP calls per run).
    const budgetReject = bridge.checkBudget()
    if (budgetReject !== null) {
      bridge.recordRejected(name, args, budgetReject)
      throw new Error(`[workflow:mcp] ${budgetReject}`)
    }

    // Recursion guard — a misbehaving MCP tool that triggers another
    // workflow agent (or another MCP call) is short-circuited before the
    // SDK dispatch rather than after.
    if (!bridge.enterDispatch()) {
      bridge.recordRejected(name, args, "MCP recursion depth exceeded")
      throw new Error(`[workflow:mcp] recursion depth limit exceeded`)
    }

    try {
      // Dispatch through parent SDK. `ctx.client.tool.call` is the OpenCode
      // convention (see agentic/runtime.ts in MiMo-Code for the upstream
      // shape). When the surface is absent we fail closed with a typed
      // error — the bridge still records the attempt for observability.
      const tool = (this.ctx.client as { tool?: { call?: (n: string, a: unknown) => Promise<unknown> } } | undefined)?.tool
      if (!tool?.call) {
        bridge.recordError(name, args, "no MCP SDK surface available")
        throw new Error(`[workflow:mcp] no MCP SDK surface available on ctx.client.tool.call`)
      }

      const result = await tool.call(name, args)
      bridge.recordCall(name, args)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // recordCall already incremented callCount on the happy path; on a
      // failed SDK call we still want it counted as "attempted" so budget
      // reflects real SDK load, not just successes.
      if (!msg.includes("no MCP SDK surface")) {
        bridge.recordError(name, args, msg)
      }
      throw e
    } finally {
      bridge.leaveDispatch()
    }
  }

  // ── Private: LLM call ──────────────────────────────────────────────────

  private async callLLM(
    entry: InternalRunEntry,
    prompt: string,
    opts: AgentOptions,
  ): Promise<{
    content: Array<{ type: string; text?: string; data?: string }>
    info?: { tokens?: { input?: number; output?: number } }
    structured?: unknown
    finalText?: string
  }> {
    // Build messages
    const systemPrompt = opts.schema
      ? `You are a workflow step. Output valid JSON matching the requested schema.`
      : `You are a workflow step. Output your result directly.`

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt },
    ]

    // Resolve `tools: "INHERIT"` against the parent MCP tool set BEFORE the
    // SDK call. Three cases:
    //   - undefined → forward literal "INHERIT" (legacy default; SDK resolves)
    //   - array → shallow-copy and forward (do NOT mutate caller's array)
    //   - "INHERIT" → discover parent tools; if discovery surface missing,
    //     fall back to the literal so the SDK still resolves it correctly.
    // The MCP bridge lives in mcp.ts; this runtime method only wires the call.
    const resolvedTools = await resolveInheritedTools(opts.tools, this.ctx)

    // Use ctx.client.session.message() — bypasses Max Mode + tool.execute hooks
    if (this.ctx.client?.session?.message) {
      return this.ctx.client.session.message({
        messages,
        model: opts.model,
        tools: resolvedTools,
      }) as Promise<{
        content: Array<{ type: string; text?: string; data?: string }>
        info?: { tokens?: { input?: number; output?: number } }
        structured?: unknown
        finalText?: string
      }>
    }

    // Fallback: no LLM client available — return empty
    return { content: [{ type: "text", text: "workflow: no LLM client available" }] }
  }

  // ── Private: child workflow ────────────────────────────────────────────

  private async startChildWorkflow(
    parent: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    _childRunID: string,
  ): Promise<InternalRunEntry> {
    // Simplified: create a new entry, run it inline
    const parsed = parseMeta(script)

    const scriptSha = computeScriptSha(script)
    // Child inherits parent's workspace (v0.13.0) so the whole workflow tree
    // stays jailed to the same directory. Persisted so child resume also
    // restores the same root.
    const childWorkspace = parent.workspace
    const runID = this.persistence.createRun(name, name, scriptSha, undefined, childWorkspace)
    await this.persistence.writeScript(runID, script)

    const entry = this.makeEntry({ runID, name: parsed.ok ? parsed.meta.name : name, cfg: parent.cfg, workspace: childWorkspace })

    this.runs.set(runID, entry)

    this.events.emit("workflow:started", { runID, name })

    this.settleEntry(entry, script, name, args, new WorkspaceJail(childWorkspace ?? process.cwd()))

    return entry
  }

  // ── Private: completion ────────────────────────────────────────────────

  private completeRun(entry: InternalRunEntry, result?: unknown): void {
    // Guard: if cancel()/failRun() already settled the entry, do not overwrite.
    // Without this, a still-pending sandbox .then() races a cancel() call and
    // overwrites entry.status / DB row from "cancelled" → "completed".
    if (entry.status !== "running") return
    entry.status = "completed"
    entry.resolveOutcome(this.outcomeFor(entry, "completed", { result }))
    this.persistence.updateRunStatus(entry.runID, "completed")
    flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: "completed" })
  }

  private failRun(entry: InternalRunEntry, error: string): void {
    if (entry.status !== "running") return
    entry.status = error.includes("budget_exceeded") || error.includes("deadline exceeded")
      ? "budget_exceeded"
      : "failed"
    entry.resolveOutcome(this.outcomeFor(entry, entry.status as "failed" | "budget_exceeded", { error }))
    this.persistence.updateRunStatus(entry.runID, entry.status, error)
    flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: entry.status, error })
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  private resolveConfig(perStepTimeoutMsOverride?: number): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    // W10/W12 — read maxDepth / maxLifecycleAgents from the SFFMC-loaded
    // extended config (workflow.yaml). The local MAX_DEPTH_DEFAULT /
    // MAX_LIFECYCLE_AGENTS constants previously shadowed the values in
    // constants.ts; those shadows are removed.
    const ext = getWorkflowConfigSync()
    // W14 — read maxSteps / maxTokens / maxWallClockMs / perStepTimeoutMs
    // from the SFFMC-loaded workflow config (this.workflowConfig), NOT from
    // this.ctx.config which is the OpenCode provider's plugin config.
    // The lookup order is: runtime-cached (YAML or test override) →
    // ctx.config (legacy fallback) → defaults.
    const src = this.workflowConfig ?? this.ctx.config ?? DEFAULT_WORKFLOW_CONFIG
    return {
      maxSteps: src.maxSteps ?? DEFAULT_WORKFLOW_CONFIG.maxSteps,
      maxTokens: src.maxTokens ?? DEFAULT_WORKFLOW_CONFIG.maxTokens,
      maxWallClockMs: src.maxWallClockMs ?? DEFAULT_WORKFLOW_CONFIG.maxWallClockMs,
      perStepTimeoutMs: perStepTimeoutMsOverride ?? src.perStepTimeoutMs ?? DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs,
      gracePeriodMs: this.gracePeriodMs,
      maxDepth: ext.maxDepth,
      maxLifecycleAgents: ext.maxLifecycleAgents,
    }
  }

  private async settleEntry(entry: InternalRunEntry, script: string, name: string, args: unknown, jail: WorkspaceJail): Promise<void> {
    try {
      const result = await this.launchScript(entry, script, name, args, jail)
      if (result === null) {
        this.failRun(entry, "Sandbox execution failed")
      } else {
        this.completeRun(entry, result !== undefined ? result : undefined)
      }
    } catch (err) {
      this.failRun(entry, err instanceof Error ? err.message : String(err))
    }
  }

  private makeEntry(opts: {
    runID: string
    name: string
    cfg: Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number }
    journalResults?: Map<string, unknown>
    journalPass?: number
    workspace?: string
  }): InternalRunEntry {
    const startedMs = Date.now()
    let resolveOutcome!: (outcome: WorkflowOutcome) => void
    const outcomePromise = new Promise<WorkflowOutcome>((res) => { resolveOutcome = res })
    return {
      runID: opts.runID,
      name: opts.name,
      status: "running",
      running: 0,
      succeeded: 0,
      failed: 0,
      agentCount: 0,
      agentCountTotal: 0,
      tokensUsed: 0,
      capWarned: false,
      childRunIDs: new Set(),
      startedMs,
      deadlineMs: startedMs + opts.cfg.maxWallClockMs,
      outcomePromise,
      resolveOutcome,
      controller: new AbortController(),
      journalResults: opts.journalResults ?? new Map(),
      journalPass: opts.journalPass ?? 0,
      cfg: opts.cfg,
      workspace: opts.workspace,
      // Per-run MCP bridge — counter is isolated so concurrent runs don't
      // share budget. Override `maxMcpCalls` via WorkflowConfig (deferred —
      // for now the constant DEFAULT_MAX_MCP_CALLS is the only knob).
      mcpBridge: new McpBridge(DEFAULT_MAX_MCP_CALLS),
    }
  }

  private outcomeFor(entry: InternalRunEntry, status: WorkflowOutcome["status"], extras?: { result?: unknown; error?: string }): WorkflowOutcome {
    return {
      runID: entry.runID,
      status,
      result: extras?.result,
      error: extras?.error,
      stepsCompleted: entry.succeeded + entry.failed,
      stepsTotal: entry.cfg.maxSteps,
      tokensUsed: entry.tokensUsed,
      durationMs: Date.now() - entry.startedMs,
    }
  }

  private publishAgentFailed(runID: string, agentKey: string, reason: AgentFailureReason): void {
    try {
      this.events.emit("workflow:agent_failed", { runID, agentKey, reason })
    } catch (e) {
      log.debug("publishAgentFailed emit error:", e)
    }
  }

  private scheduleFlush(entry: InternalRunEntry): void {
    if (this.flushTimers.has(entry.runID)) return
    const t = setTimeout(() => {
      this.flushTimers.delete(entry.runID)
      this.flushNow(entry)
    }, 250)
    t.unref?.()
    this.flushTimers.set(entry.runID, t)
  }

  private flushNow(entry: InternalRunEntry): void {
    const t = this.flushTimers.get(entry.runID)
    if (t) {
      clearTimeout(t)
      this.flushTimers.delete(entry.runID)
    }
    // Update DB counters
    const db = this.persistence.getDB()
    try {
      db.run(
        `UPDATE workflow_runs SET running = ?, succeeded = ?, failed = ?, time_updated = ? WHERE id = ?`,
        [entry.running, entry.succeeded, entry.failed, Math.floor(Date.now() / 1000), entry.runID],
      )
    } catch (e) {
      log.debug("flushNow DB update error:", e)
    }
  }
}
