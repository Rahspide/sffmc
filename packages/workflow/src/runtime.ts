// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import {
  WorkflowPersistence,
  generateRunID,
  computeScriptSha,
  journalKeyBase,
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
  DEFAULT_SANDBOX_CONSTRAINTS,
  AgentFailureReason as AFR,
} from "./types.ts"
import { getBuiltin, loadBuiltin } from "./builtin-registry.ts"
import { cpus } from "node:os"
import { type RichPluginContext } from "@sffmc/shared"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCRIPT_DEADLINE_MS = 12 * 60 * 60 * 1000 // 12h
const MAX_LIFECYCLE_AGENTS = 1000
const DEFAULT_MAX_CONCURRENT = Math.min(16, 2 * Math.max(1, cpus().length))
const MAX_DEPTH_DEFAULT = 8
const MAX_TOKENS_DEFAULT = 2_000_000

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
}

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface RuntimeOpts {
  /** Optional persistence instance. When omitted, a default on-disk
   *  persistence is created using XDG_DATA_HOME or ~/.local/share. */
  persistence?: WorkflowPersistence
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

  constructor(ctx: PluginContext, opts?: RuntimeOpts) {
    this.ctx = ctx
    this.globalSem = makeSemaphore(DEFAULT_MAX_CONCURRENT)
    this.persistence = opts?.persistence ?? new WorkflowPersistence()
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async start(input: WorkflowStartInput & { sessionID?: string; name?: string }): Promise<{ runID: string }> {

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
    const runID = this.persistence.createRun(name, name, scriptSha)
    await this.persistence.writeScript(runID, script)

    // Resolve workspace
    const workspace = input.workspace ?? process.cwd()
    const jail = new WorkspaceJail(workspace)

    // Load journal (empty on fresh run)
    const journal = await this.persistence.loadJournal(runID)

    const entry = this.makeEntry({ runID, name, cfg, journalResults: journal.results, journalPass: journal.pass })

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

      const journal = await this.persistence.loadJournal(input.runID)

      const entry = this.makeEntry({ runID: input.runID, name, cfg, journalResults: journal.results, journalPass: journal.pass })

      this.runs.set(input.runID, entry)
      this.persistence.updateRunStatus(input.runID, "running")

      this.events.emit("workflow:started", { runID: input.runID, name })

      this.settleEntry(entry, script, name, row.args, new WorkspaceJail(process.cwd()))

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

  /** Recover orphaned workflows on startup. */
  async recoverOrphanedWorkflows(): Promise<void> {
    const rows = this.persistence.listRuns()
    for (const row of rows) {
      if (row.status === "running" && !this.runs.has(row.runID)) {
        this.persistence.updateRunStatus(row.runID, "crashed", "Process restarted — workflow orphaned")
      }
    }
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
      return readFile(input.file, "utf-8")
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
      args,
    }

    // Deterministic seed from runID
    const seed = createHash("sha1").update(entry.runID).digest().readUInt32BE(0)

    // Append auto-invocation of main() — mirrors the old new Function pattern
    const source = body + "\n;return typeof main === 'function' ? await main() : undefined"

    const result = await runSandboxed(source, primitives, {
      memoryMB: 64,
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
          console.warn(`[workflow] lifecycle cap ${entry.cfg.maxLifecycleAgents} reached for ${entry.runID}`)
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
    })
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
      const workspace = process.cwd()
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

    // Use ctx.client.session.message() — bypasses Max Mode + tool.execute hooks
    if (this.ctx.client?.session?.message) {
      return this.ctx.client.session.message({
        messages,
        model: opts.model,
        tools: opts.tools ? [...opts.tools] as string[] : "INHERIT",
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
    const runID = this.persistence.createRun(name, name, scriptSha)
    await this.persistence.writeScript(runID, script)

    const entry = this.makeEntry({ runID, name: parsed.ok ? parsed.meta.name : name, cfg: parent.cfg })

    this.runs.set(runID, entry)

    this.events.emit("workflow:started", { runID, name })

    this.settleEntry(entry, script, name, args, new WorkspaceJail(process.cwd()))

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
    this.events.emit("workflow:finished", { runID: entry.runID, status: "completed" })
  }

  private failRun(entry: InternalRunEntry, error: string): void {
    if (entry.status !== "running") return
    entry.status = error.includes("budget_exceeded") || error.includes("deadline exceeded")
      ? "budget_exceeded"
      : "failed"
    entry.resolveOutcome(this.outcomeFor(entry, entry.status as "failed" | "budget_exceeded", { error }))
    this.persistence.updateRunStatus(entry.runID, entry.status, error)
    this.events.emit("workflow:finished", { runID: entry.runID, status: entry.status, error })
  }

  // ── Private: helpers ───────────────────────────────────────────────────

  private resolveConfig(perStepTimeoutMsOverride?: number): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    return {
      maxSteps: this.ctx.config?.maxSteps ?? DEFAULT_WORKFLOW_CONFIG.maxSteps,
      maxTokens: this.ctx.config?.maxTokens ?? MAX_TOKENS_DEFAULT,
      maxWallClockMs: this.ctx.config?.maxWallClockMs ?? DEFAULT_WORKFLOW_CONFIG.maxWallClockMs,
      perStepTimeoutMs: perStepTimeoutMsOverride ?? this.ctx.config?.perStepTimeoutMs ?? DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs,
      maxDepth: MAX_DEPTH_DEFAULT,
      maxLifecycleAgents: MAX_LIFECYCLE_AGENTS,
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
    } catch {
      // observability must never escape
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
    } catch {
      // best-effort
    }
  }
}
