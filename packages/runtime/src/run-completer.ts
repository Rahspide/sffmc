// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Run completion lifecycle, extracted from WorkflowRuntime per the
// v0.16.0 refactor plan (ora-7, Phase 3). The WorkflowRuntime class
// holds a reference to a `RunCompleter` instance and delegates the
// `completeRun` / `failRun` / `settleEntry` public surface to it,
// preserving the call-site shape while moving the implementation
// into a focused module.
//
// Why a class (not free functions): the methods form a small state
// machine (running → completed | failed | budget_exceeded) that
// touches 4 external collaborators (persistence, events, outcomes,
// runs registry). Bundling them into a class makes the dependency
// graph explicit and unit-testable in isolation.

import { outcomeFor, type InternalRunEntry } from "./internal-run-entry.ts"
import type { IRunCompleter } from "./runtime-services.ts"
import type { WorkflowPersistence } from "./persistence.ts"
import type { WorkflowEventEmitter } from "./event-emitter.ts"
import type { OutcomeStore, WorkflowOutcome } from "./outcome-store.ts"
import type { WorkflowActivation } from "./activation.ts"
import { BudgetExceededError, WorkflowStatus } from "./types.ts"

export interface RunCompleterDeps {
  persistence: WorkflowPersistence
  events: WorkflowEventEmitter
  outcomes: OutcomeStore<string, WorkflowOutcome>
  runs: WorkflowActivation<InternalRunEntry>
  /** Wrapper around the sandbox launch. Passed in so RunCompleter
   *  doesn't need to know how a run is executed — it only knows
   *  how to settle (route result to completeRun / failRun) once
   *  the wrapper resolves. */
  launchScript: (
    entry: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    jail: unknown,
  ) => Promise<unknown>
}

export class RunCompleter implements IRunCompleter {
  constructor(private readonly deps: RunCompleterDeps) {}

  /** Mark the run as completed. Guarded: if `cancel()` or `failRun()`
   *  already settled the entry, do not overwrite. Without this guard,
   *  a still-pending sandbox `.then()` races a `cancel()` call and
   *  overwrites `entry.status` / DB row from "cancelled" → "completed". */
  completeRun(entry: InternalRunEntry, result?: unknown): void {
    if (entry.status !== "running") return
    entry.status = "completed"
    const outcome = outcomeFor(entry, "completed", { result })
    entry.resolveOutcome(outcome)
    this.deps.persistence.updateRunStatus(entry.runID, "completed")
    this.deps.persistence.flushJournalSync()
    this.deps.events.emit("workflow:finished", { runID: entry.runID, status: "completed" })
    // v0.14.x C-2 — cache the resolved outcome (late wait() callers still
    // need it) then drop the entry from `this.runs` so the McpBridge,
    // journalResults Map, childRunIDs Set, AbortController, and closures
    // are GC-eligible.
    this.deps.outcomes.put(entry.runID, outcome)
    this.deps.runs.release(entry.runID)
  }

  /** Mark the run as failed or budget_exceeded (the latter when a
   *  `BudgetExceededError` is passed). Guarded like completeRun. */
  failRun(entry: InternalRunEntry, error: string | Error): void {
    if (entry.status !== "running") return
    entry.status = error instanceof BudgetExceededError
      ? WorkflowStatus.BudgetExceeded
      : WorkflowStatus.Failed
    // Persist the original message: BudgetExceededError.message carries the
    // human-readable cause (e.g. "Token budget exceeded: cap … exceeded"),
    // and `.message` is the same as the input for plain strings.
    const errorMessage = error instanceof Error ? error.message : error
    const outcome = outcomeFor(entry, entry.status as "failed" | "budget_exceeded", { error: errorMessage })
    entry.resolveOutcome(outcome)
    this.deps.persistence.updateRunStatus(entry.runID, entry.status, errorMessage)
    this.deps.persistence.flushJournalSync()
    this.deps.events.emit("workflow:finished", { runID: entry.runID, status: entry.status, error: errorMessage })
    // v0.14.x C-2 — cache + release (see completeRun comment)
    this.deps.outcomes.put(entry.runID, outcome)
    this.deps.runs.release(entry.runID)
  }

  /** Run the sandbox via the injected `launchScript`, then route the
   *  result to `completeRun` (success) or `failRun` (sandbox returned
   *  null or threw). The try/catch wraps both the await and the
   *  settlement so a throw from `completeRun`/`failRun` does not
   *  propagate (callers expect settleEntry to never throw). */
  async settleEntry(
    entry: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    jail: unknown,
  ): Promise<void> {
    try {
      const result = await this.deps.launchScript(entry, script, name, args, jail)
      if (result === null) {
        this.failRun(entry, "Sandbox execution failed")
      } else {
        this.completeRun(entry, result !== undefined ? result : undefined)
      }
    } catch (err) {
      this.failRun(entry, err instanceof Error ? err.message : String(err))
    }
  }
}
