// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// CounterManager — extracted from WorkflowRuntime (M-1 god-object refactor,
// Task 1.2). Owns the per-run counter state previously held inline on
// InternalRunEntry: running, succeeded, failed, agentCount, agentCountTotal,
// tokensUsed. Each InternalRunEntry now holds one CounterManager instance.
//
// Why per-entry, not per-runtime: counters describe a single workflow run
// (running agents, lifetime agent total, accumulated tokens for the
// maxTokens budget check). Multiple concurrent runs have independent
// counters — the runtime itself is not a counter aggregator. The brief's
// sketch placed CounterManager on WorkflowRuntime, but inspection of
// runtime.ts showed every counter mutation site reads/writes `entry.x`,
// never `this.x`, so the natural home is per-entry.
//
// Field names match InternalRunEntry verbatim (running / succeeded / failed
// / agentCount / agentCountTotal / tokensUsed) — no rename drift, no test
// fixtures to update beyond the fake-entry shape.

/** Immutable snapshot of counter state at a point in time. Returned by
 *  `CounterManager.snapshot()`. The shape is also what `flushNow()` reads
 *  via `entry.counters.x` when writing to the DB. */
export interface CounterSnapshot {
  running: number
  succeeded: number
  failed: number
  agentCount: number
  agentCountTotal: number
  tokensUsed: number
}

export class CounterManager {
  // Public numeric fields — kept public so existing reflection-based tests
  // (runtime-coverage.test.ts, spawn-child-coverage.test.ts) and DB-flush
  // sites that read `entry.counters.running` etc. can mirror the previous
  // direct-field access without renames. Mutate via the recordXxx() methods
  // so the multi-field invariants (e.g. onAgentStart bumps 3 fields in sync)
  // stay encapsulated.
  running = 0
  succeeded = 0
  failed = 0
  agentCount = 0
  agentCountTotal = 0
  tokensUsed = 0

  /** Agent invocation begins. Bumps `running`, `agentCount`, and
   *  `agentCountTotal`. Matches the 3-line increment block at
   *  runtime.ts:789-791. */
  recordAgentStart(): void {
    this.running++
    this.agentCount++
    this.agentCountTotal++
  }

  /** Agent completed successfully. Decrements `running`, increments
   *  `succeeded`. Matches runtime.ts:852-853. */
  recordAgentSucceed(): void {
    this.running--
    this.succeeded++
  }

  /** Agent failed (deliverable null, spawn rejection, etc.). Decrements
   *  `running`, increments `failed`. Matches runtime.ts:823-824,
   *  845-846, 867-868. */
  recordAgentFail(): void {
    this.running--
    this.failed++
  }

  /** Journal-hit (cached) result — succeeded++ without a corresponding
   *  `running--`, because the agent never actually started. Matches
   *  runtime.ts:748 (agent journal hit) and runtime.ts:919 (child
   *  workflow journal hit). */
  recordJournalHit(): void {
    this.succeeded++
  }

  /** Track LLM token usage for the maxTokens budget check. Adds
   *  `input + output` to `tokensUsed`. Callers pass `(tokens?.input ?? 0,
   *  tokens?.output ?? 0)` from runtime.ts:812-813. */
  addTokens(input: number, output: number): void {
    this.tokensUsed += (input ?? 0) + (output ?? 0)
  }

  /** Zero all counters. Used by `reset()` on the runtime for fresh runs. */
  reset(): void {
    this.running = 0
    this.succeeded = 0
    this.failed = 0
    this.agentCount = 0
    this.agentCountTotal = 0
    this.tokensUsed = 0
  }

  /** Read-only view of current counter state. Returns a fresh object so
   *  callers cannot mutate internal state by accident. */
  snapshot(): CounterSnapshot {
    return {
      running: this.running,
      succeeded: this.succeeded,
      failed: this.failed,
      agentCount: this.agentCount,
      agentCountTotal: this.agentCountTotal,
      tokensUsed: this.tokensUsed,
    }
  }
}