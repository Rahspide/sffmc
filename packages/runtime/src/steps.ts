// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Step CRUD repository, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 6). Wraps the `workflow_steps` table with
// typed methods: checkpointStep (atomic BEGIN EXCLUSIVE/COMMIT) and
// loadCompletedSteps. The WorkflowPersistence class delegates to this
// repository.

import { safeRunID, unixNow } from "@sffmc/utilities"
import type { WorkflowStep } from "./types.ts"
import type { Database } from "bun:sqlite"
import type { SqliteRow } from "./runs.ts"

export class StepsRepository {
  constructor(private readonly db: Database) {}

  /** Atomic step checkpoint. Uses BEGIN EXCLUSIVE/COMMIT so a concurrent
   *  reader (or another writer on the same db) blocks until COMMIT —
   *  guarantees the (run_id, step_index) row is fully written before
   *  the run's time_updated is bumped. ROLLBACK on any error so the
   *  step row is never half-written. */
  checkpointStep(runID: string, step: WorkflowStep): void {
    safeRunID(runID)
    this.db.run("BEGIN EXCLUSIVE")
    try {
      this.db.run(
        `INSERT INTO workflow_steps (run_id, step_index, kind, input_prompt, output_result, cost_tokens, duration_ms, error, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id, step_index) DO UPDATE SET
           output_result = excluded.output_result,
           cost_tokens = excluded.cost_tokens,
           duration_ms = excluded.duration_ms,
           error = excluded.error`,
        [
          runID,
          step.stepIndex,
          step.kind,
          step.input ?? null,
          step.output ?? null,
          step.costTokens,
          step.durationMs,
          step.error ?? null,
          step.timestamp,
        ],
      )
      this.db.run(
        `UPDATE workflow_runs SET time_updated = ? WHERE id = ?`,
        [unixNow(), runID],
      )
      this.db.run("COMMIT")
    } catch (e) {
      this.db.run("ROLLBACK")
      throw e
    }
  }

  // SAFETY: loadCompletedSteps returns WorkflowStep[]; the type annotation reflects the mapped rows from SELECT * on workflow_steps
  loadCompletedSteps(runID: string): WorkflowStep[] {
    safeRunID(runID)
    // SAFETY: bun:sqlite's `.all()` returns unknown[]; the cast re-states the documented SqliteRow[] shape for the selected columns
    const rows = this.db
      .query("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index")
      .all(runID) as SqliteRow[]
    return rows.map((row) => ({
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `run_id` column is TEXT NOT NULL
      runID: row.run_id as string,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `step_index` column is INTEGER NOT NULL
      stepIndex: row.step_index as number,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `kind` column is TEXT with WorkflowStep["kind"] values
      kind: row.kind as WorkflowStep["kind"],
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `input_prompt` column is TEXT nullable
      input: (row.input_prompt as string) || undefined,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `output_result` column is TEXT nullable
      output: (row.output_result as string) || undefined,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `cost_tokens` column is INTEGER NOT NULL
      costTokens: row.cost_tokens as number,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `duration_ms` column is INTEGER NOT NULL
      durationMs: row.duration_ms as number,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `error` column is TEXT nullable
      error: (row.error as string) || undefined,
      // SAFETY: row comes from SELECT * on workflow_steps (typed schema); `timestamp` column is INTEGER NOT NULL
      timestamp: row.timestamp as number,
    }))
  }
}
