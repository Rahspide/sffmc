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

  loadCompletedSteps(runID: string): WorkflowStep[] {
    safeRunID(runID)
    const rows = this.db
      .query("SELECT * FROM workflow_steps WHERE run_id = ? ORDER BY step_index")
      .all(runID) as Record<string, unknown>[]
    return rows.map((row) => ({
      runID: row.run_id as string,
      stepIndex: row.step_index as number,
      kind: row.kind as WorkflowStep["kind"],
      input: (row.input_prompt as string) || undefined,
      output: (row.output_result as string) || undefined,
      costTokens: row.cost_tokens as number,
      durationMs: row.duration_ms as number,
      error: (row.error as string) || undefined,
      timestamp: row.timestamp as number,
    }))
  }
}
