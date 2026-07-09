// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { createHash } from "node:crypto"
import {
  WorkflowPersistence,
  generateRunID,
  computeScriptSha,
  journalKeyBase,
} from "./persistence.ts"
import { OutcomeStore } from "./outcome-store.ts"
import { CounterManager } from "./counter-manager.ts"
import { WorkflowEventEmitter } from "./event-emitter.ts"
import { WorkflowActivation } from "./activation.ts"
import { createEventBus } from "./events.ts"
import { makeSemaphore, Concurrency } from "./concurrency.ts"
import { makeEntry, outcomeFor, type InternalRunEntry } from "./internal-run-entry.ts"
import { resolveWorkflowScript } from "./script-resolver.ts"
import { FlushManager } from "./flush-manager.ts"
import { RuntimeConfig } from "./runtime-config.ts"
import { RunCompleter } from "./run-completer.ts"
import { McpDispatcher } from "./mcp-dispatcher.ts"
import { AgentPrimitive } from "./agent-primitive.ts"

import { parseMeta } from "./meta.ts"
import { callLLM as callLLMModule } from "./llm-call.ts"
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
import { type RichPluginContext, createLogger, loadConfig } from "@sffmc/utilities";
import { resolveInheritedTools, McpBridge, DEFAULT_MAX_MCP_CALLS, discoverParentTools } from "./mcp.ts";

// ---------------------------------------------------------------------------
// Constants
//
// these values used to be hardcoded shadows of constants.ts.
// They now read from the SFFMC workflow config (`getWorkflowConfigSync()`)
// so user YAML overrides take effect. The prior hardcoded values (1000 / 16)
// are preserved as the defaults in DEFAULT_WORKFLOW_EXTENDED_CONFIG.
// ---------------------------------------------------------------------------

const log = createLogger("workflow")
// global agent-concurrency cap. Reads `maxConcurrentAgents` from the
// SFFMC config (overrideable via `workflow.yaml`). The default is 16 (matches
// the pre-fix value). Called in the constructor (not at module
// init) so a test that mutates the config cache via `__setWorkflowConfig()`
// between constructions picks up the updated value.
function resolveMaxConcurrentAgents(): number {
  return getMaxConcurrentAgents()
}

/** Capacity for the completed-outcomes LRU. Reads
 *  `WORKFLOW_OUTCOMES_CACHE_SIZE` from the environment; falls back to 500
 *  on missing/invalid/negative values. */
function resolveOutcomesCacheSize(): number {
  const raw = process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
  if (raw === undefined) return 500
  const n = Number.parseInt(raw, 10)
  if (!Number.isInteger(n) || n < 0) {
    log.warn(`Invalid WORKFLOW_OUTCOMES_CACHE_SIZE=${raw}; using default 500`)
    return 500
  }
  return n
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
  /**  synchronous config override for tests. Skips the async YAML
   *  load. When set, the runtime uses these values for maxSteps / maxTokens /
   *  maxWallClockMs / perStepTimeoutMs in `resolveConfig()`. The SFFMC
   *  extended config (maxDepth, maxLifecycleAgents, maxConcurrentAgents)
   *  is unaffected — use `__setWorkflowConfig()` from constants.ts for
   *  those. */
  configOverride?: Partial<WorkflowConfig>
  /** Override for the completed-outcomes LRU capacity. Default: env var
   *  `WORKFLOW_OUTCOMES_CACHE_SIZE`, then 500. */
  completedOutcomesCacheSize?: number
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  private ctx: PluginContext
  /** In-flight run registry (M-1 god-object refactor, Task 1.5).
   *  Replaces the inline `private runs = new Map<string, InternalRunEntry>()`
   *  that previously lived directly on WorkflowRuntime. All read/write
   *  sites (`runs.set / get / has / delete / clear` and `for-of` loops)
   *  route through `this.runs.<method>` — see activation.ts for the full
   *  contract and activation.test.ts for the regression net. */
  private runs = new WorkflowActivation<InternalRunEntry>()
  private globalSem: ReturnType<typeof makeSemaphore>
  /** Per-runtime concurrency primitives (L-3, Task 2.7). Owns the
   *  `acquireLock("workflow-resume:" + runID)` chain map so concurrent
   *  `resume()` calls on the same runID serialize correctly. Previously
   *  the lock chain was a module-level `Map` shared by every caller in
   *  the process — moved to instance state for hermetic test isolation. */
  private concurrency = new Concurrency()
  private flushManager: FlushManager
  private persistence: WorkflowPersistence
  /** Event bus for observability listeners.
   *  One emitter per runtime, shared across all runs (Task 1.3, M-1
   *  god-object extract — `WorkflowEventEmitter` class extracted from
   *  the inline `createEventBus()` factory). Per-run vs per-runtime: the
   *  event bus is per-runtime because observability listeners
   *  (`runtime.events.on(...)` in `index.ts` `server()`) need to see
   *  every run's events from a single registration point, not
   *  re-register per run. The per-run split applies to `CounterManager`
   *  because counter state is per-run; events are global. */
  readonly events = new WorkflowEventEmitter()
  /** v0.16.0 refactor (Phase 2): runtime config state + lifecycle
   *  extracted to `src/runtime-config.ts`. The runtime holds an instance
   *  per-runtime and delegates the public surface (setGracePeriodMs,
   *  setConfig, loadWorkflowConfig, resolveConfig) to it. Per-runtime
   *  class (not a module-level singleton) so tests that call
   *  `setConfig(null)` between cases get hermetic resets by constructing
   *  a new runtime. */
  private runtimeConfig: RuntimeConfig
  /** v0.16.0 refactor (Phase 3): run completion lifecycle extracted
   *  to `src/run-completer.ts`. The runtime holds an instance and
   *  delegates the public surface (completeRun, failRun, settleEntry)
   *  to it. Per-runtime class (not a module-level singleton) so tests
   *  that mock the dependencies get hermetic resets. */
  private runCompleter: RunCompleter
  /** v0.16.0 refactor (Phase 4): MCP tool dispatch extracted to
   *  `src/mcp-dispatcher.ts`. The runtime holds an instance and
   *  delegates `dispatchMcpList` / `dispatchMcpCall` to it. */
  private mcpDispatcher: McpDispatcher
  /** v0.16.0 refactor (Phase 5): agent primitives extracted to
   *  `src/agent-primitive.ts`. The runtime holds an instance and
   *  delegates `spawnAgent`, `executeAgentCall`, `runParallel`,
   *  `runPipeline`, `publishAgentFailed` to it. */
  private agentPrimitive: AgentPrimitive
  /** v0.14.x C-2 — cached resolved outcomes for settled runs. The
   *  `completeRun` / `failRun` / `cancel` paths delete the entry from
   *  `this.runs` so its McpBridge / journalResults / AbortController /
   *  closures are GC-eligible, but `wait()` may still be called after
   *  settle (e.g. a test that awaits the workflow and then inspects
   *  the outcome). The resolved outcome is stored here keyed by runID
   *  so late `wait()` calls return the same value as the in-flight
   *  entry would have.
   *
   *  Bounded via OutcomeStore (which wraps a BoundedLRU) so a long-lived
   *  daemon doesn't grow this map unbounded (each entry can hold step
   *  results, error messages, tokensUsed). Capacity is configured via the
   *  `completedOutcomesCacheSize` RuntimeOpt or the
   *  `WORKFLOW_OUTCOMES_CACHE_SIZE` env var (default: 500). Evicted
   *  runIDs fall back to "unknown runID" — acceptable per the design
   *  comment above. Cleared by `close()`. */
  private outcomes: OutcomeStore<string, WorkflowOutcome>

  constructor(ctx: PluginContext, opts: RuntimeOpts = {}) {
    this.ctx = ctx
    this.globalSem = makeSemaphore(resolveMaxConcurrentAgents())
    this.persistence = opts.persistence ?? new WorkflowPersistence()
    this.flushManager = new FlushManager(this.persistence)
    // OutcomeStore cache — bounded LRU so long-lived daemons don't grow
    // indefinitely. Opt > env > 500 default.
    this.outcomes = new OutcomeStore<string, WorkflowOutcome>(
      opts.completedOutcomesCacheSize ?? resolveOutcomesCacheSize(),
    )
    //  resolve at constructor time (not module init) so the
    // semaphore respects a config the caller may set via
    // `__setWorkflowConfig()` before constructing the runtime.
    this.runtimeConfig = new RuntimeConfig({
      getCtxConfig: () => this.ctx.config,
    })
    this.runCompleter = new RunCompleter({
      persistence: this.persistence,
      events: this.events,
      outcomes: this.outcomes,
      runs: this.runs,
      launchScript: this.launchScript.bind(this) as RunCompleterDeps["launchScript"],
    })
    this.mcpDispatcher = new McpDispatcher({
      getCtx: () => this.ctx,
    })
    this.agentPrimitive = new AgentPrimitive({
      globalSem: this.globalSem,
      scheduleFlush: this.scheduleFlush.bind(this),
      emitEvent: (name: string, payload: unknown) => this.events.emit(name, payload),
      callLLM: this.callLLM.bind(this) as AgentPrimitiveDeps["callLLM"],
      appendJournal: (runID: string, e: unknown) => this.persistence.appendJournalSync(runID, e),
      failRun: this.failRun.bind(this),
    })
    if (opts.gracePeriodMsOverride !== undefined) {
      this.runtimeConfig.setGracePeriodMs(opts.gracePeriodMsOverride)
    }
    if (opts.configOverride) {
      this.runtimeConfig.setConfig(opts.configOverride)
    }
  }

  /** workflow recovery grace period — set the grace period at runtime. Used by the index.ts config
   *  hook after `loadConfig` returns. Validates the value (integer,
   *  0..24h) and throws on out-of-range. Delegates to `RuntimeConfig`. */
  setGracePeriodMs(ms: number): void {
    this.runtimeConfig.setGracePeriodMs(ms)
  }

  /**  synchronously inject a workflow config. Used by tests via
   *  `RuntimeOpts.configOverride` to skip the async YAML load. Merges
   *  onto `DEFAULT_WORKFLOW_CONFIG` via spread so missing keys fall back
   *  to defaults, and new fields added to `WorkflowConfig` are auto-
   *  populated (no compile-time drift). When set, subsequent
   *  `loadWorkflowConfig()` calls are no-ops unless `null` is passed
   *  (which re-enables the YAML load). */
  setConfig(cfg: Partial<WorkflowConfig> | null): void {
    this.runtimeConfig.setConfig(cfg)
  }

  /**  lazily load the SFFMC workflow config from `workflow.yaml`.
   *  Idempotent — concurrent callers all await the same in-flight promise
   *  (no TOCTOU race when `start()` and `resume()` are called concurrently).
   *  No-op when the config was already injected (test override path).
   *  Delegates to `RuntimeConfig`. */
  /** in-flight promise cache for `loadWorkflowConfig()`. Prevents the
   *  TOCTOU race when `start()` and `resume()` are called concurrently:
   *  both pass the early guard and race to invoke the YAML loader.
   *  Cleared via `setConfig(null)` (delegated to `RuntimeConfig`). */
  private loadWorkflowConfigPromise: Promise<void> | null = null

  async loadWorkflowConfig(): Promise<void> {
    if (this.loadWorkflowConfigPromise) return this.loadWorkflowConfigPromise
    this.loadWorkflowConfigPromise = this.doLoadWorkflowConfig()
    return this.loadWorkflowConfigPromise
  }

  /** Internal YAML loader — kept on this class as a thin pass-through
   *  to `RuntimeConfig.doLoad()` so existing reflection-based tests
   *  (`runtime as unknown as { doLoadWorkflowConfig: ... }`) keep working
   *  without modification. The real implementation lives in
   *  `src/runtime-config.ts`. */
  private async doLoadWorkflowConfig(): Promise<void> {
    return this.runtimeConfig.loadConfig()
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(input: WorkflowStartInput & { sessionID?: string; name?: string }): Promise<{ runID: string }> {

    // Workflow config — lazily load the SFFMC workflow config from `workflow.yaml`
    // before `resolveConfig()` reads it. Idempotent; no-op for tests
    // that injected a config via `RuntimeOpts.configOverride`.
    await this.loadWorkflowConfig()

    // Resolve script
    const script = await resolveWorkflowScript(input)

    const parsed = parseMeta(script)
    if (!parsed.ok) {
      throw new Error(`Workflow script invalid: ${parsed.error}`)
    }

    const name = parsed.meta.name

    // Resolve config
    const cfg = this.resolveConfig()

    // Persist — createRun generates its own runID, use that as ours
    const scriptSha = computeScriptSha(script)
    // Resolve workspace  so it persists alongside the run row.
    // resume() restores from this column instead of falling back to cwd.
    const workspace = input.workspace ?? process.cwd()
    const runID = this.persistence.createRun(name, name, scriptSha, undefined, workspace, input.args)
    await this.persistence.writeScript(runID, script)

    const jail = new WorkspaceJail(workspace)

    // Load journal (empty on fresh run)
    const journal = await this.persistence.loadJournal(runID)

    const entry = makeEntry({ runID, name, cfg, journalResults: journal.results, journalPass: journal.pass, workspace })

    this.runs.register(runID, entry)

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
      agentCount: entry.counters.agentCount,
      succeeded: entry.counters.succeeded,
      failed: entry.counters.failed,
      currentPhase: entry.currentPhase,
      stepsCompleted: entry.counters.succeeded + entry.counters.failed,
      stepsTotal: entry.cfg.maxSteps,
      tokensUsed: entry.counters.tokensUsed,
    }
  }

  async wait(input: { runID: string; timeoutMs?: number }): Promise<WorkflowOutcome> {
    const entry = this.runs.get(input.runID)
    if (!entry) {
      // v0.14.x C-2 — settled runs are removed from `this.runs` (so their
      // McpBridge / journalResults / AbortController are GC-eligible). A
      // late `wait()` for a settled runID returns the cached outcome
      // instead of a synthetic "unknown runID" failure.
      const completed = this.outcomes.get(input.runID)
      if (completed) return completed
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
        stepsCompleted: entry.counters.succeeded + entry.counters.failed,
        stepsTotal: entry.cfg.maxSteps,
        tokensUsed: entry.counters.tokensUsed,
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
    const outcome = outcomeFor(entry, "cancelled")
    entry.resolveOutcome(outcome)
    this.persistence.updateRunStatus(entry.runID, "cancelled")
    this.persistence.flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: "cancelled" })
    // v0.14.x C-2 — cache the resolved outcome (late wait() callers still
    // need it) then drop the entry from `this.runs` so the McpBridge,
    // journalResults Map, AbortController, and closures are GC-eligible.
    this.outcomes.put(entry.runID, outcome)
    this.runs.release(entry.runID)
  }

  async list(): Promise<Array<{ runID: string; name: string; status: WorkflowStatus }>> {
    // Combine in-memory and DB rows
    const dbRuns = this.persistence.listRuns()
    const result = new Map<string, { runID: string; name: string; status: WorkflowStatus }>()

    for (const row of dbRuns) {
      result.set(row.runID, { runID: row.runID, name: row.name, status: row.status })
    }
    for (const [id, entry] of this.runs.iter()) {
      result.set(id, { runID: id, name: entry.name, status: entry.status })
    }

    return [...result.values()]
  }

  async resume(input: { runID: string; agentTimeoutMs?: number }): Promise<{ runID: string; resumed: boolean }> {
    // Workflow config — same lazy load as `start()` so resume() picks up the YAML
    // config on  call.
    await this.loadWorkflowConfig()
    const lock = await this.concurrency.acquireLock("workflow-resume:" + input.runID)
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

      // Restore the original lexical jail root from the DB. Pre-v0.13.0
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

      const entry = makeEntry({ runID: input.runID, name, cfg, journalResults: journal.results, journalPass: journal.pass, workspace: resumeWorkspace })

      this.runs.register(input.runID, entry)
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
    for (const [, entry] of this.runs.iter()) {
      if (entry.status === "running") {
        entry.controller.abort()
        entry.status = "cancelled"
      }
    }
    // v0.14.x C-2 — clear `this.runs` after cancel loop. Without this,
    // every entry — completed/failed/cancelled/crashed — holds an
    // mcpBridge (McpBridge with up to 1000 records), journalResults Map,
    // childRunIDs Set, AbortController, and closures for the lifetime of
    // the runtime. close() is the  line of defense after the
    // per-settle deletes in completeRun/failRun/cancel.
    this.runs.clear()
    // Also drop the completed-outcomes cache — the runtime is going away
    // and any further `wait()` calls are meaningless.
    this.outcomes.clear()
    // Clear event listeners
    this.events.clearAll()
    // Clear flush timers
    this.flushManager.clearAll()
    // Close persistence (DB connection)
    this.persistence.close()
  }

  /** Recover orphaned workflows on startup.
   *  Any run left in 'running' status after a process restart is orphaned.
   *  Lock recovery is N/A — the `Concurrency` instance's lockMap is
   *  in-process only (lives on `this.concurrency`, not on disk); there
   *  is no on-disk lock to recover. After this method returns, all
   *  orphaned runs are either marked 'paused' (resumable) or 'crashed'
   *  (no journal).
   *
   *  workflow recovery grace period — grace period: a row with `time_created` within `gracePeriodMs`
   *  of now is always marked 'paused' (regardless of journal presence);
   *  rows past the grace use the legacy journal-presence check.
   *  See v0.14 design §3.2. */
  async recoverOrphanedWorkflows(): Promise<void> {
    const rows = this.persistence.listRunningRuns()
    const nowMs = Date.now()
    const graceMs = this.runtimeConfig.getGracePeriodMs()
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
    this.persistence.flushJournalSync()
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
      // sandbox memory now reads from SFFMC config
      // (workflow.yaml key: \`sandboxMemoryMB\`). Default 64 MiB matches
      // the pre-fix value.
      memoryMB: getSandboxMemoryMB(),
      deadlineMs: SCRIPT_DEADLINE_MS, // 12h wall-clock for the sandbox
      seed,
      runID: entry.runID,
    })

    // runSandboxed never throws per contract — null means sandbox error
    return result
  }

  // ── Private: primitives (extracted from launchScript) ───────────────────

  /** v0.16.0 refactor (Phase 5): delegates to `AgentPrimitive.spawnAgent()`.
   *  Journal cache lookup, lifecycle/token/step caps, abort check, depth
   *  check, and counter invariants all live in `src/agent-primitive.ts`. */
  private async spawnAgent(
    entry: InternalRunEntry,
    task: string,
    opts: AgentOptions | undefined,
    occ: Map<string, number>,
  ): Promise<AgentResult> {
    return this.agentPrimitive.spawnAgent(entry, task, opts, occ)
  }

  /** v0.16.0 refactor (Phase 5): delegates to `AgentPrimitive.executeAgentCall()`.
   *  LLM call, token tracking, deliverable extraction, journal append,
   *  and error handling all live in `src/agent-primitive.ts`. */
  private async executeAgentCall(
    entry: InternalRunEntry,
    promptStr: string,
    agentOpts: AgentOptions,
    key: string,
  ): Promise<AgentResult | null> {
    return this.agentPrimitive.executeAgentCall(entry, promptStr, agentOpts, key)
  }

  /** v0.16.0 refactor (Phase 5): delegates to `AgentPrimitive.runParallel()`. */
  private async runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    return this.agentPrimitive.runParallel(thunks)
  }

  /** v0.16.0 refactor (Phase 5): delegates to `AgentPrimitive.runPipeline()`. */
  private async runPipeline<T>(
    items: T[],
    stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>,
  ): Promise<Array<unknown>> {
    return this.agentPrimitive.runPipeline(items, stages)
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
      entry.counters.recordJournalHit()
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

  /** v0.16.0 refactor (Phase 4): delegates to `McpDispatcher.list()`. */
  private async dispatchMcpList(entry: InternalRunEntry): Promise<string[]> {
    return this.mcpDispatcher.list(entry)
  }

  /** v0.16.0 refactor (Phase 4): delegates to `McpDispatcher.call()`.
   *  Budget gate + recursion guard + SDK dispatch + bridge bookkeeping
   *  all live in `src/mcp-dispatcher.ts`. */
  private async dispatchMcpCall(
    entry: InternalRunEntry,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    return this.mcpDispatcher.call(entry, name, args)
  }

  // ── Private: LLM call ──────────────────────────────────────────────────

  /** Delegate to the extracted `callLLM` module (see `src/llm-call.ts`).
   *  Lifted out per the v0.16.0 refactor plan; the implementation is pure
   *  over `this.ctx` + `entry` + `opts` + `prompt`, so it does not need any
   *  runtime state. Kept as a method on this class (rather than a direct
   *  import) to preserve the call-site shape for the 9-test call graph in
   *  `runtime-coverage.test.ts` and the `runtime-flushNow` reflection
   *  contract. */
  private callLLM(
    entry: InternalRunEntry,
    prompt: string,
    opts: AgentOptions,
  ): ReturnType<typeof callLLMModule> {
    return callLLMModule(this.ctx as Parameters<typeof callLLMModule>[0], entry, prompt, opts)
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
    // Child inherits parent's workspace so the whole workflow tree
    // stays jailed to the same directory. Persisted so child resume also
    // restores the same root.
    const childWorkspace = parent.workspace
    const runID = this.persistence.createRun(name, name, scriptSha, undefined, childWorkspace, args)
    await this.persistence.writeScript(runID, script)

    const entry = makeEntry({ runID, name: parsed.ok ? parsed.meta.name : name, cfg: parent.cfg, workspace: childWorkspace })

    this.runs.register(runID, entry)

    this.events.emit("workflow:started", { runID, name })

    this.settleEntry(entry, script, name, args, new WorkspaceJail(childWorkspace ?? process.cwd()))

    return entry
  }

  // ── Private: completion ────────────────────────────────────────────────

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.completeRun()`.
   *  The status guard, outcome creation, persistence flush, event emit,
   *  and outcome-cache+runs-release are all in `src/run-completer.ts`. */
  private completeRun(entry: InternalRunEntry, result?: unknown): void {
    this.runCompleter.completeRun(entry, result)
  }

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.failRun()`.
   *  The "budget_exceeded" magic-string classification, status guard,
   *  persistence flush, event emit, and outcome-cache+runs-release are
   *  all in `src/run-completer.ts`. */
  private failRun(entry: InternalRunEntry, error: string): void {
    this.runCompleter.failRun(entry, error)
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  /** v0.16.0 refactor (Phase 2): delegates to `RuntimeConfig.resolve()`. The
   *  full precedence chain (cache > ctx.config > defaults) + extended
   *  config (maxDepth, maxLifecycleAgents) lives in `src/runtime-config.ts`. */
  private resolveConfig(perStepTimeoutMsOverride?: number): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    return this.runtimeConfig.resolve(perStepTimeoutMsOverride)
  }

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.settleEntry()`.
   *  The launch + route-to-completeRun-or-failRun logic is in
   *  `src/run-completer.ts`; the runtime injects `launchScript` as a
   *  callback at construction time. */
  private async settleEntry(entry: InternalRunEntry, script: string, name: string, args: unknown, jail: WorkspaceJail): Promise<void> {
    return this.runCompleter.settleEntry(entry, script, name, args, jail)
  }

  /** v0.16.0 refactor (Phase 5): delegates to `AgentPrimitive.publishAgentFailed()`.
   *  The try/catch around emit + log.debug is in `src/agent-primitive.ts`. */
  private publishAgentFailed(runID: string, agentKey: string, reason: AgentFailureReason): void {
    this.agentPrimitive.publishAgentFailed(runID, agentKey, reason)
  }

  /** Schedule a debounced DB counter flush for `entry`. Delegates to
   *  `FlushManager` (M-1 god-object extract, Task 1.6). Kept as a
   *  runtime-instance method so internal call sites read naturally. */
  private scheduleFlush(entry: InternalRunEntry): void {
    this.flushManager.scheduleFlush(entry)
  }

  /** Flush the DB counter row for `entry` immediately, cancelling any
   *  pending debounce timer. Delegates to `FlushManager`. Kept as a
   *  runtime-instance method because `runtime-coverage.test.ts` and
   *  `lru-cache.test.ts` invoke this via reflection (`runtime as unknown as
   *  { flushNow: ... }`). */
  private flushNow(entry: InternalRunEntry): void {
    this.flushManager.flushNow(entry)
  }
}
