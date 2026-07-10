// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

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
import { makeSemaphore, Concurrency } from "./concurrency.ts"
import { makeEntry, outcomeFor, type InternalRunEntry } from "./internal-run-entry.ts"
import { resolveWorkflowScript } from "./script-resolver.ts"
import { FlushManager } from "./flush-manager.ts"
import { RuntimeConfig } from "./runtime-config.ts"
import { RunCompleter } from "./run-completer.ts"
import { McpDispatcher } from "./mcp-dispatcher.ts"
import { AgentPrimitive } from "./agent-primitive.ts"
import { ChildWorkflowPrimitive } from "./child-workflow-primitive.ts"

import { parseMeta } from "./meta.ts"
import { callLLM as callLLMModule } from "./llm-call.ts"
import {
  resolveWorkflow,
  isInlineScript,
} from "./resolve.ts"
import { WorkspaceJail } from "./workspace.ts"
import { launchScript, type LaunchDeps } from "./script-launcher.ts"
import { recoverOrphanedWorkflows } from "./recovery.ts"
import { runSandboxed } from "./sandbox"
import type {
  WorkflowConfig,
  WorkflowStatus,
  WorkflowStartInput,
  WorkflowStatusOutput,
  WorkflowOutcome,
  WorkflowOutcomeStore,
  RunEntry,
} from "./types.ts"
import type { RuntimeServices } from "./runtime-services.ts"
import { SCRIPT_DEADLINE_MS, getMaxConcurrentAgents, getSandboxMemoryMB } from "./constants.ts"
import { type RichPluginContext, createLogger } from "@sffmc/utilities"

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
  /** Override for the completed-outcomes LRU capacity. Default: env var
   *  `WORKFLOW_OUTCOMES_CACHE_SIZE`, then 500. */
  completedOutcomesCacheSize?: number

  // ── v0.16.0-SOLID: dependency injection for orchestrator services.
  //     When omitted, the runtime builds the real sub-components.
  //     Tests pass a partial container to override one or more. ──

  /** Sub-component services (runCompleter, mcpDispatcher, agentPrimitive,
   *  childWorkflowPrimitive). Partial — unspecified fields default to
   *  the real implementations. */
  services?: Partial<RuntimeServices>
}

// ---------------------------------------------------------------------------
// WorkflowRuntime
// ---------------------------------------------------------------------------

export class WorkflowRuntime {
  // Sub-component fields — each extracted from the god-class per the
  // v0.16.0-SOLID plan (Phases 2-6). The runtime holds a per-instance
  // reference and delegates the narrow public surface to each.
  //   runs / flushManager / persistence / concurrency / globalSem
  //     — orchestrator state, not delegated.
  //   events — per-runtime event bus (observability).
  //   runtimeConfig (Phase 2) — setGracePeriodMs/setConfig/loadConfig/resolve
  //   runCompleter (Phase 3) — completeRun/failRun/settleEntry
  //   mcpDispatcher (Phase 4) — list/call
  //   agentPrimitive (Phase 5) — spawnAgent/runParallel/runPipeline/publishAgentFailed
  //   childWorkflowPrimitive (Phase 6) — spawn/start/setPhase/appendLog
  private ctx: PluginContext
  private runs = new WorkflowActivation<InternalRunEntry>()
  private globalSem: ReturnType<typeof makeSemaphore>
  private concurrency = new Concurrency()
  private flushManager: FlushManager
  private persistence: WorkflowPersistence
  readonly events = new WorkflowEventEmitter()
  private runtimeConfig: RuntimeConfig
  private runCompleter: RunCompleter
  private mcpDispatcher: McpDispatcher
  private agentPrimitive: AgentPrimitive
  private childWorkflowPrimitive: ChildWorkflowPrimitive
  /** v0.16.0-SOLID: sub-component services container. Tests pass
   *  a partial container to override one or more sub-components;
   *  production callers omit the `services` opt and get the real
   *  implementations wired by the constructor. */
  protected services: RuntimeServices
  /** v0.14.x C-2 — cached resolved outcomes for settled runs. Late
   *  `wait()` callers (after the in-flight entry was released on
   *  settle) read from this store. Bounded via OutcomeStore
   *  (BoundedLRU), capacity from `completedOutcomesCacheSize` opt or
   *  `WORKFLOW_OUTCOMES_CACHE_SIZE` env var (default: 500). Evicted
   *  runIDs fall back to "unknown runID". Cleared by `close()`. */
  private outcomes: WorkflowOutcomeStore

  constructor(ctx: PluginContext, opts: RuntimeOpts = {}) {
    this.ctx = ctx
    this.globalSem = makeSemaphore(resolveMaxConcurrentAgents())
    this.persistence = opts.persistence ?? new WorkflowPersistence()
    this.flushManager = new FlushManager(this.persistence)
    // OutcomeStore cache — bounded LRU so long-lived daemons don't grow
    // indefinitely. Opt > env > 500 default. The assignment is
    // type-compatible with the `WorkflowOutcomeStore` alias field
    // without an explicit cast (`OutcomeStore<string, WorkflowOutcome>`
    // is exactly what the alias resolves to).
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
      launchScript: this.buildLaunchScriptFn(),
    })
    this.mcpDispatcher = new McpDispatcher({
      getCtx: () => this.ctx,
    })
    this.agentPrimitive = new AgentPrimitive({
      globalSem: this.globalSem,
      scheduleFlush: (entry) => this.flushManager.scheduleFlush(entry),
      emitEvent: (name: string, payload: unknown) => this.events.emit(name, payload),
      callLLM: (entry, prompt, opts) => callLLMModule(this.ctx as Parameters<typeof callLLMModule>[0], entry, prompt, opts),
      appendJournal: (runID: string, e: unknown) => this.persistence.appendJournalSync(runID, e),
      failRun: (entry, error) => this.runCompleter.failRun(entry, error),
    })
    this.childWorkflowPrimitive = new ChildWorkflowPrimitive({
      persistence: this.persistence,
      events: this.events,
      runs: this.runs,
      scheduleFlush: (entry) => this.flushManager.scheduleFlush(entry),
      startChildWorkflow: (parent, script, name, args, childRunID) =>
        this.services.childWorkflowPrimitive.start(parent, script, name, args, childRunID),
      appendJournal: (runID: string, e: unknown) => this.persistence.appendJournal(runID, e),
      settleEntry: (entry, script, name, args, jail) =>
        this.runCompleter.settleEntry(entry, script, name, args, jail),
    })

    // v0.16.0-SOLID: store the sub-components container. Tests can supply
    // a partial container via `opts.services` to override individual
    // sub-components. Production callers omit the opt.
    //
    // `globalSem` lives in the container so tests can swap the
    // concurrency cap (e.g. `makeSemaphore(1)` for hermetic
    // isolation) without reflection or subclassing. Override
    // precedence: `opts.services.globalSem` wins over the default
    // `this.globalSem` constructed above. Placed after the spread so
    // a missing/undefined override in `opts.services` falls back to
    // `this.globalSem` rather than getting clobbered by `undefined`.
    this.services = {
      runCompleter: this.runCompleter,
      mcpDispatcher: this.mcpDispatcher,
      agentPrimitive: this.agentPrimitive,
      childWorkflowPrimitive: this.childWorkflowPrimitive,
      ...opts.services,
      globalSem: opts.services?.globalSem ?? this.globalSem,
    }
  }

  /** workflow recovery grace period — set the grace period at runtime. Used by the index.ts config
   *  hook after `loadConfig` returns. Validates the value (integer,
   *  0..24h) and throws on out-of-range. Delegates to `RuntimeConfig`. */
  setGracePeriodMs(ms: number): void {
    this.runtimeConfig.setGracePeriodMs(ms)
  }

  /**  synchronously inject a workflow config. Used by tests via
   *  post-construction `runtime.setConfig(cfg)` to skip the async YAML
   *  load (call BEFORE the first `start()` / `resume()` so the override
   *  is observed). Merges onto `DEFAULT_WORKFLOW_CONFIG` via spread so
   *  missing keys fall back to defaults, and new fields added to
   *  `WorkflowConfig` are auto-populated (no compile-time drift). When
   *  set, subsequent `loadWorkflowConfig()` calls are no-ops unless
   *  `null` is passed (which re-enables the YAML load). */
  setConfig(cfg: Partial<WorkflowConfig> | null): void {
    this.runtimeConfig.setConfig(cfg)
  }

  /** Lazily load the SFFMC workflow config from `workflow.yaml`.
   *  Idempotent — in-flight promise cached in `loadWorkflowConfigPromise`
   *  so concurrent `start()` / `resume()` callers share one YAML load
   *  (no TOCTOU race). No-op when the config was injected via
   *  `setConfig(cfg)` (test override path). Delegates to `RuntimeConfig`. */
  private loadWorkflowConfigPromise: Promise<void> | null = null

  async loadWorkflowConfig(): Promise<void> {
    if (this.loadWorkflowConfigPromise) return this.loadWorkflowConfigPromise
    this.loadWorkflowConfigPromise = this.runtimeConfig.loadConfig()
    return this.loadWorkflowConfigPromise
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(input: WorkflowStartInput & { sessionID?: string; name?: string }): Promise<{ runID: string }> {

    // Workflow config — lazily load the SFFMC workflow config from `workflow.yaml`
    // before `resolveConfig()` reads it. Idempotent; no-op for tests
    // that injected a config via `runtime.setConfig(cfg)` post-construction.
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
    // v0.14.x C-2 — clear `this.runs` so mcpBridge / journalResults /
    // AbortController / closures are GC-eligible (close() is the
    // last line of defense after the per-settle deletes).
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
   *  See v0.14 design §3.2.
   *
   *  v0.16.0-SOLID wave 2: the per-row classification loop is
   *  extracted to `src/recovery.ts` (module-level function with
   *  injected `RecoveryDeps`). The runtime injects its
   *  `persistence` + `runs` and reads the current `gracePeriodMs`
   *  from `RuntimeConfig` at call time. */
  async recoverOrphanedWorkflows(): Promise<void> {
    await recoverOrphanedWorkflows(
      { persistence: this.persistence, runs: this.runs },
      this.runtimeConfig.getGracePeriodMs(),
    )
  }

  // ── Private: launch ────────────────────────────────────────────────────

  /** Build the closure that `RunCompleter` invokes to run a guest
   *  script. Wires the runtime's sub-components (agent primitive,
   *  child workflow primitive, MCP dispatcher) into a `LaunchDeps`
   *  bag and delegates to the module-level `launchScript` function.
   *  The function pointer is stable for the lifetime of the runtime
   *  — re-built only by tests that swap `opts.services` (rare). */
  private buildLaunchScriptFn(): RunCompleterDeps["launchScript"] {
    // Snapshot the sub-component references once. If a test swaps
    // `this.services` after construction, the in-flight `RunCompleter`
    // would still see the originals — by design, the launch closure
    // captures per-runtime state at the moment of build, not at the
    // moment of invocation. (The pre-extraction `this.launchScript.bind(this)`
    // had the same behavior; preserved here for regression fidelity.)
    const launchDeps: LaunchDeps = {
      spawnAgent: (entry, task, opts, occ) =>
        this.services.agentPrimitive.spawnAgent(entry, task, opts, occ),
      runParallel: <T>(thunks: Array<() => Promise<T>>) =>
        this.services.agentPrimitive.runParallel<T>(thunks),
      runPipeline: <T>(
        items: T[],
        stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>,
      ) => this.services.agentPrimitive.runPipeline<T>(items, stages),
      spawnChildWorkflow: (entry, nameOrScript, childArgs, occ) =>
        this.services.childWorkflowPrimitive.spawn(entry, nameOrScript, childArgs, occ),
      setPhase: (entry, title) => this.services.childWorkflowPrimitive.setPhase(entry, title),
      appendLog: (entry, msg) => this.services.childWorkflowPrimitive.appendLog(entry, msg),
      dispatchMcpList: (entry) => this.services.mcpDispatcher.list(entry),
      dispatchMcpCall: (entry, name, args) => this.services.mcpDispatcher.call(entry, name, args),
      runSandboxed,
      deadlineMs: SCRIPT_DEADLINE_MS,
    }
    return (entry, script, name, args, jail: unknown) =>
      launchScript(launchDeps, entry, script, name, args, jail as WorkspaceJail)
  }

  // ── Private: completion (kept as a thin public surface for
  //    reflection-based test access — `lru-cache.test.ts` and
  //    `spawn-child-coverage.test.ts` poke at these methods directly). ─

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.completeRun()`.
   *  The status guard, outcome creation, persistence flush, event emit,
   *  and outcome-cache+runs-release are all in `src/run-completer.ts`. */
  completeRun(entry: InternalRunEntry, result?: unknown): void {
    this.runCompleter.completeRun(entry, result)
  }

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.failRun()`.
   *  The `BudgetExceededError`-based classification, status guard,
   *  persistence flush, event emit, and outcome-cache+runs-release are
   *  all in `src/run-completer.ts`. */
  failRun(entry: InternalRunEntry, error: string | Error): void {
    this.runCompleter.failRun(entry, error)
  }

  /** v0.16.0 refactor (Phase 6): delegates to `ChildWorkflowPrimitive.spawn()`.
   *  Journal cache lookup, script resolution, child sub-run launch, and
   *  outcome waiting all live in `src/child-workflow-primitive.ts`.
   *  Kept as a runtime method (not just inlined into the launch
   *  closure) because `spawn-child-coverage.test.ts` reaches in via
   *  reflection to drive this code path without spinning up a real
   *  sandbox. */
  async spawnChildWorkflow(
    entry: InternalRunEntry,
    nameOrScript: string,
    childArgs: unknown,
    workflowOcc: Map<string, number>,
  ): Promise<unknown> {
    return this.childWorkflowPrimitive.spawn(entry, nameOrScript, childArgs, workflowOcc)
  }

  /** v0.16.0 refactor (Phase 2): delegates to `RuntimeConfig.resolve()`.
   *  The full precedence chain (cache > ctx.config > defaults) + extended
   *  config (maxDepth, maxLifecycleAgents) lives in
   *  `src/runtime-config.ts`. Kept as a runtime method (not inlined at
   *  the two call sites in `start()` / `resume()`) so the call sites
   *  read as one expression. */
  resolveConfig(perStepTimeoutMsOverride?: number): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    return this.runtimeConfig.resolve(perStepTimeoutMsOverride)
  }

  /** v0.16.0 refactor (Phase 3): delegates to `RunCompleter.settleEntry()`.
   *  The launch + route-to-completeRun-or-failRun logic is in
   *  `src/run-completer.ts`; the runtime injects `launchScript` as a
   *  callback at construction time. Kept as a method (not inlined at
   *  the two call sites in `start()` / `resume()`) so `RunCompleter`'s
   *  contract is reachable by name from the public surface. */
  async settleEntry(entry: InternalRunEntry, script: string, name: string, args: unknown, jail: WorkspaceJail): Promise<void> {
    return this.runCompleter.settleEntry(entry, script, name, args, jail)
  }
}
