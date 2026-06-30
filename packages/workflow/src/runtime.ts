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
import { OutcomeStore } from "./outcome-store.ts"
import { CounterManager } from "./counter-manager.ts"
import { WorkflowEventEmitter } from "./event-emitter.ts"
import { WorkflowActivation } from "./activation.ts"
import { createEventBus } from "./events.ts"
import { makeSemaphore, acquireLock } from "./concurrency.ts"
import { makeEntry, outcomeFor } from "./internal-run-entry.ts"

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
import { type RichPluginContext, createLogger, loadConfig } from "@sffmc/shared";
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
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
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
  /** workflow recovery grace period — grace period in ms, populated by the index.ts config hook
   *  via `loadConfig<WorkflowConfig>("workflow", ...)`. Tests may also
   *  inject a value via `RuntimeOpts.gracePeriodMsOverride`. Stored on
   *  the runtime (not the plugin context) so `recoverOrphanedWorkflows()`
   *  can read it synchronously. */
  private gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS
  /**  SFFMC-loaded workflow config (maxSteps / maxTokens /
   *  maxWallClockMs / perStepTimeoutMs). Populated lazily by
   *  `loadWorkflowConfig()` on the  `start()` or `resume()` call.
   *  Tests inject via `RuntimeOpts.configOverride` (sync, no YAML).
   *  Resolved values: prefer this cache → ctx.config (OpenCode provider) →
   *  DEFAULT_WORKFLOW_CONFIG. */
  private workflowConfig: Required<WorkflowConfig> | null = null
  /**  flag to skip async YAML load when the test override is set. */
  private workflowConfigInjected: boolean = false
  /**  in-flight promise cache for `loadWorkflowConfig()`. Prevents the
   *  TOCTOU race when `start()` and `resume()` are called concurrently:
   *  both pass the `if (this.workflowConfig) return` guard while the
   *  cache is `null`, then race to invoke `loadConfig()`. With this
   *  cache, concurrent callers all await the same promise. Cleared by
   *  `setConfig(null)` so a subsequent YAML load can re-fire after an
   *  override is cleared. */
  private loadWorkflowConfigPromise: Promise<void> | null = null
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
    //  resolve at constructor time (not module init) so the
    // semaphore respects a config the caller may set via
    // `__setWorkflowConfig()` before constructing the runtime.
    this.globalSem = makeSemaphore(resolveMaxConcurrentAgents())
    this.persistence = opts.persistence ?? new WorkflowPersistence()
    if (opts.gracePeriodMsOverride !== undefined) {
      this.setGracePeriodMs(opts.gracePeriodMsOverride)
    }
    if (opts.configOverride) {
      this.setConfig(opts.configOverride)
    }
    // OutcomeStore cache — bounded LRU so long-lived daemons don't grow
    // indefinitely. Opt > env > 500 default.
    this.outcomes = new OutcomeStore<string, WorkflowOutcome>(
      opts.completedOutcomesCacheSize ?? resolveOutcomesCacheSize(),
    )
  }

  /** workflow recovery grace period — set the grace period at runtime. Used by the index.ts config
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

  /**  synchronously inject a workflow config. Used by tests via
   *  `RuntimeOpts.configOverride` to skip the async YAML load. Merges
   *  onto `DEFAULT_WORKFLOW_CONFIG` via spread so missing keys fall back
   *  to defaults, and new fields added to `WorkflowConfig` are auto-
   *  populated (no compile-time drift). When set, subsequent
   *  `loadWorkflowConfig()` calls are no-ops unless `null` is passed
   *  (which re-enables the YAML load). */
  setConfig(cfg: Partial<WorkflowConfig> | null): void {
    if (cfg === null) {
      this.workflowConfig = null
      this.workflowConfigInjected = false
      // Clear the in-flight promise cache so the next `loadWorkflowConfig()`
      // call re-fires `loadConfig()` instead of returning a stale promise.
      this.loadWorkflowConfigPromise = null
      return
    }
    this.workflowConfig = {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...cfg,
    } as Required<WorkflowConfig>
    this.workflowConfigInjected = true
  }

  /**  lazily load the SFFMC workflow config from `workflow.yaml`.
   *  Idempotent — concurrent callers all await the same in-flight promise
   *  (no TOCTOU race when `start()` and `resume()` run concurrently).
   *  No-op when the config was already injected (test override path).
   *  Called eagerly by `start()` / `resume()` before `resolveConfig()` runs. */
  async loadWorkflowConfig(): Promise<void> {
    if (this.workflowConfigInjected) return
    if (this.workflowConfig !== null) return
    if (this.loadWorkflowConfigPromise) return this.loadWorkflowConfigPromise
    this.loadWorkflowConfigPromise = this.doLoadWorkflowConfig()
    return this.loadWorkflowConfigPromise
  }

  /**  internal YAML loader. Cached via `loadWorkflowConfigPromise`
   *  so concurrent callers share the same promise. Uses spread to
   *  populate every `WorkflowConfig` field from defaults, so new fields
   *  added to the interface are auto-included (no manual mapping list
   *  to maintain). */
  private async doLoadWorkflowConfig(): Promise<void> {
    const loaded = await loadConfig<typeof DEFAULT_WORKFLOW_CONFIG>(
      "workflow",
      DEFAULT_WORKFLOW_CONFIG,
    )
    this.workflowConfig = {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...loaded,
    } as Required<WorkflowConfig>
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(input: WorkflowStartInput & { sessionID?: string; name?: string }): Promise<{ runID: string }> {

    // Workflow config — lazily load the SFFMC workflow config from `workflow.yaml`
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
    flushJournalSync()
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
    for (const [, t] of this.flushTimers) {
      clearTimeout(t)
    }
    this.flushTimers.clear()
    // Close persistence (DB connection)
    this.persistence.close()
  }

  /** Recover orphaned workflows on startup.
   *  Any run left in 'running' status after a process restart is orphaned.
   *  Lock recovery is N/A — lockMap at module scope is in-process only;
   *  there is no on-disk lock. After this method returns, all orphaned
   *  runs are either marked 'paused' (resumable) or 'crashed' (no journal).
   *
   *  workflow recovery grace period — grace period: a row with `time_created` within `gracePeriodMs`
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
      entry.counters.recordJournalHit()
      this.scheduleFlush(entry)
      return entry.journalResults.get(key) as AgentResult
    }

    // Run under semaphore
    return this.globalSem.run(async () => {
      // Lifecycle cap
      if (entry.counters.agentCountTotal >= entry.cfg.maxLifecycleAgents) {
        if (!entry.capWarned) {
          entry.capWarned = true
          log.warn(`lifecycle cap ${entry.cfg.maxLifecycleAgents} reached for ${entry.runID}`)
        }
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        return null
      }

      // Token cap
      if (entry.counters.tokensUsed >= entry.cfg.maxTokens) {
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        return null
      }

      // Check maxSteps
      if (entry.counters.succeeded + entry.counters.failed >= entry.cfg.maxSteps) {
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
      entry.counters.recordAgentStart()
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
      entry.counters.addTokens(tokens?.input ?? 0, tokens?.output ?? 0)

      // Check token cap
      if (entry.counters.tokensUsed >= entry.cfg.maxTokens) {
        this.events.emit("workflow:step_checkpoint", {
          runID: entry.runID,
          stepIndex: entry.counters.succeeded + entry.counters.failed,
          costTokens: totalTokens,
        })
        entry.counters.recordAgentFail()
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        this.scheduleFlush(entry)
        // Settle the run so this.runs drops it, entry.status flips to
        // "budget_exceeded", DB row updates, outcome resolves (so wait()
        // returns), and workflow:finished fires — all in one path.
        // failRun's pattern match on "budget_exceeded" in the error sets
        // the right status. The previous code emitted workflow:finished
        // directly but never settled the run: status stayed "running",
        // the run entry leaked in this.runs, wait() hung forever, and
        // subsequent agents kept executing.
        this.failRun(entry, `Token budget_exceeded: cap ${entry.cfg.maxTokens} exceeded`)
        return null
      }

      // Extract deliverable
      const deliverable = o.schema
        ? (result.structured ?? null)
        : (result.structured ?? result.finalText ?? null)

      if (deliverable === null) {
        reason = AFR.NoDeliverable
        entry.counters.recordAgentFail()
        this.publishAgentFailed(entry.runID, key, reason)
        this.scheduleFlush(entry)
        return null
      }

      entry.counters.recordAgentSucceed()
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
      entry.counters.recordAgentFail()
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

  private completeRun(entry: InternalRunEntry, result?: unknown): void {
    // Guard: if cancel()/failRun() already settled the entry, do not overwrite.
    // Without this, a still-pending sandbox .then() races a cancel() call and
    // overwrites entry.status / DB row from "cancelled" → "completed".
    if (entry.status !== "running") return
    entry.status = "completed"
    const outcome = outcomeFor(entry, "completed", { result })
    entry.resolveOutcome(outcome)
    this.persistence.updateRunStatus(entry.runID, "completed")
    flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: "completed" })
    // v0.14.x C-2 — cache the resolved outcome (late wait() callers still
    // need it) then drop the entry from `this.runs` so the McpBridge,
    // journalResults Map, childRunIDs Set, AbortController, and closures
    // are GC-eligible. Without this, every completed run leaks its
    // entry for the lifetime of the runtime.
    this.outcomes.put(entry.runID, outcome)
    this.runs.release(entry.runID)
  }

  private failRun(entry: InternalRunEntry, error: string): void {
    if (entry.status !== "running") return
    entry.status = error.includes("budget_exceeded") || error.includes("deadline exceeded")
      ? "budget_exceeded"
      : "failed"
    const outcome = outcomeFor(entry, entry.status as "failed" | "budget_exceeded", { error })
    entry.resolveOutcome(outcome)
    this.persistence.updateRunStatus(entry.runID, entry.status, error)
    flushJournalSync()
    this.events.emit("workflow:finished", { runID: entry.runID, status: entry.status, error })
    // v0.14.x C-2 — cache the resolved outcome (late wait() callers still
    // need it) then drop the entry from `this.runs` so the McpBridge,
    // journalResults Map, childRunIDs Set, AbortController, and closures
    // are GC-eligible. Without this, every failed run leaks its entry
    // for the lifetime of the runtime.
    this.outcomes.put(entry.runID, outcome)
    this.runs.release(entry.runID)
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  private resolveConfig(perStepTimeoutMsOverride?: number): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    // read maxDepth / maxLifecycleAgents from the SFFMC-loaded
    // extended config (workflow.yaml). The local MAX_DEPTH_DEFAULT /
    // MAX_LIFECYCLE_AGENTS constants previously shadowed the values in
    // constants.ts; those shadows are removed.
    const ext = getWorkflowConfigSync()
    // Workflow config — read maxSteps / maxTokens / maxWallClockMs / perStepTimeoutMs
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
      // Defensive `?? 0` — the schema requires NOT NULL for running /
      // succeeded / failed (schema.ts:13-16). In production, `makeEntry()`
      // always initializes `entry.counters = new CounterManager()` so the
      // `??` is a no-op. But tests that drive internal methods via
      // reflection (e.g. `runtime-coverage.test.ts`,
      // `spawn-child-coverage.test.ts`) build minimal fake entries that
      // may not include `counters`. When those tests trigger
      // `scheduleFlush` indirectly, the timer fires 250ms later and
      // `flushNow` would throw on `entry.counters.running`. The
      // optional-chaining + `?? 0` coercion matches the previous
      // behavior (zero-default for missing fields) so the UPDATE
      // succeeds silently.
      db.run(
        `UPDATE workflow_runs SET running = ?, succeeded = ?, failed = ?, time_updated = ? WHERE id = ?`,
        [
          entry.counters?.running ?? 0,
          entry.counters?.succeeded ?? 0,
          entry.counters?.failed ?? 0,
          Math.floor(Date.now() / 1000),
          entry.runID,
        ],
      )
    } catch (e) {
      log.debug("flushNow DB update error:", e)
    }
  }
}
