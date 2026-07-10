// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Agent primitives, extracted from WorkflowRuntime per the v0.16.0
// refactor plan (ora-7, Phase 5). The runtime holds a reference to
// an `AgentPrimitive` instance and delegates `spawnAgent`,
// `executeAgentCall`, `runParallel`, `runPipeline`, and
// `publishAgentFailed` to it, preserving the call-site shape while
// moving the implementation into a focused module.
//
// Why a class (not free functions): the 5 methods form a small
// orchestration surface that touches 8 collaborators (entry counters,
// journal, abort signal, semaphore, persistence, events, LLM call,
// run completer). Bundling them makes the dependency graph explicit
// and unit-testable in isolation.

import { journalKeyBase } from "./persistence.ts"
import type { IAgentPrimitive } from "./runtime-services.ts"
import { createLogger } from "@sffmc/utilities"
import type { InternalRunEntry, AgentResult } from "./internal-run-entry.ts"
import type { AgentOptions, AgentFailureReason } from "./types.ts"
import { AgentFailureReason as AFR, BudgetExceededError } from "./types.ts"

const log = createLogger("workflow:agent-primitive")

export interface AgentPrimitiveDeps {
  /** Acquire a slot from the global semaphore (limits concurrent
   *  in-flight agent calls across all runs). */
  globalSem: { run: <T>(fn: () => Promise<T>) => Promise<T> }
  /** Flush counters to the DB (debounced). */
  scheduleFlush: (entry: InternalRunEntry) => void
  /** Emit an arbitrary event on the workflow event bus. */
  emitEvent: (name: string, payload: unknown) => void
  /** Call the LLM (delegates to `callLLM` module). */
  callLLM: (entry: InternalRunEntry, prompt: string, opts: AgentOptions) => Promise<{
    content: Array<{ type: string; text?: string; data?: string }>
    info?: { tokens?: { input?: number; output?: number } }
    structured?: unknown
    finalText?: string
  }>
  /** Append a successful agent result to the journal. */
  appendJournal: (runID: string, entry: unknown) => void
  /** Settle the run as failed (with the given error). Accepts a string
   *  (legacy callers) or an Error instance (the typed path used for
   *  budget-exceeded classification — see `BudgetExceededError`). */
  failRun: (entry: InternalRunEntry, error: string | Error) => void
}

export class AgentPrimitive implements IAgentPrimitive {
  constructor(private readonly deps: AgentPrimitiveDeps) {}

  /** agent(task, opts?) — called from inside the sandbox. */
  async spawnAgent(
    entry: InternalRunEntry,
    task: string,
    opts: AgentOptions | undefined,
    occ: Map<string, number>,
  ): Promise<AgentResult> {
    const agentOpts = opts ?? ({} as AgentOptions)
    const promptStr = String(task)

    // Journal cache lookup
    const base = journalKeyBase(promptStr, {
      agentType: undefined,
      model: agentOpts.model,
      schema: agentOpts.schema,
      phase: agentOpts.phase,
    })
    const n = occ.get(base) ?? 0
    occ.set(base, n + 1)
    const key = base + ":" + n

    if (entry.journalResults.has(key)) {
      entry.counters.recordJournalHit()
      this.deps.scheduleFlush(entry)
      return entry.journalResults.get(key) as AgentResult
    }

    // Run under semaphore
    return this.deps.globalSem.run(async () => {
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
      const depth = agentOpts.depth ?? 0
      if (depth > entry.cfg.maxDepth) {
        throw new Error(`Workflow nesting depth (${depth}) exceeds maxDepth (${entry.cfg.maxDepth})`)
      }

      // Counter invariants: running++ before spawn
      entry.counters.recordAgentStart()
      this.deps.scheduleFlush(entry)

      return this.executeAgentCall(entry, promptStr, agentOpts, key)
    })
  }

  /** Internal: call LLM and process the result. Extracted from
   *  spawnAgent to keep the semaphore/cap-check flow separate from
   *  the LLM execution. */
  async executeAgentCall(
    entry: InternalRunEntry,
    promptStr: string,
    agentOpts: AgentOptions,
    key: string,
  ): Promise<AgentResult | null> {
    let reason: AgentFailureReason = AFR.ActorError
    try {
      const result = await this.deps.callLLM(entry, promptStr, agentOpts)

      // Track tokens
      const tokens = result.info?.tokens
      const totalTokens = (tokens?.input ?? 0) + (tokens?.output ?? 0)
      entry.counters.addTokens(tokens?.input ?? 0, tokens?.output ?? 0)

      // Check token cap
      if (entry.counters.tokensUsed >= entry.cfg.maxTokens) {
        this.deps.emitEvent("workflow:step_checkpoint", {
          runID: entry.runID,
          stepIndex: entry.counters.succeeded + entry.counters.failed,
          costTokens: totalTokens,
        })
        entry.counters.recordAgentFail()
        this.publishAgentFailed(entry.runID, key, AFR.OverCap)
        this.deps.scheduleFlush(entry)
        // Settle the run so this.runs drops it, entry.status flips to
        // "budget_exceeded", DB row updates, outcome resolves (so wait()
        // returns), and workflow:finished fires — all in one path.
        this.deps.failRun(entry, new BudgetExceededError(`Token budget exceeded: cap ${entry.cfg.maxTokens} exceeded`))
        return null
      }

      // Extract deliverable
      const deliverable = agentOpts.schema
        ? (result.structured ?? null)
        : (result.structured ?? result.finalText ?? null)

      if (deliverable === null) {
        reason = AFR.NoDeliverable
        entry.counters.recordAgentFail()
        this.publishAgentFailed(entry.runID, key, reason)
        this.deps.scheduleFlush(entry)
        return null
      }

      entry.counters.recordAgentSucceed()
      this.deps.scheduleFlush(entry)

      // Journal successful result
      this.deps.appendJournal(entry.runID, {
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
      this.deps.scheduleFlush(entry)
      return null
    }
  }

  /** parallel(thunks) — Promise.all wrapper. */
  async runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
    const results: Array<T | null> = []
    const promises = thunks.map((thunk) => thunk())
    const settled = await Promise.all(promises)
    for (const r of settled) results.push(r)
    return results
  }

  /** pipeline(items, ...stages) — sequential stages. */
  async runPipeline<T>(
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

  /** Publish a workflow:agent_failed event. Wrapped in try/catch so
   *  listener errors don't propagate (observability listeners can be
   *  user-supplied and must not break the run). */
  publishAgentFailed(runID: string, agentKey: string, reason: AgentFailureReason): void {
    try {
      this.deps.emitEvent("workflow:agent_failed", { runID, agentKey, reason })
    } catch (e) {
      // Stringify the error so bun test runner doesn't capture the Error
      // object as an "uncaught error" and hang on stack-trace printing in
      // batch-mode (it does this even though the throw is caught here).
      log.debug("publishAgentFailed emit error:", e instanceof Error ? e.message : String(e))
    }
  }
}