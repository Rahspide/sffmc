// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Run CRUD repository, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 5). Wraps the `workflow_runs` table with
// typed methods: createRun, loadRun, updateRunStatus, listRuns,
// listRunningRuns. The WorkflowPersistence class delegates to this
// repository while keeping its public API unchanged.

import { generateRunID } from "./runid.ts"
import { safeRunID, unixNow, createLogger } from "@sffmc/utilities"
import type { WorkflowRun, WorkflowStatus } from "./types.ts"
import type { Database } from "bun:sqlite"

const log = createLogger("workflow:runs")

/** Map a workflow_runs row to the typed WorkflowRun shape.
 *  Args round-trip through JSON.parse (with try/catch fallback to
 *  undefined for malformed entries — the row was written by us, but
 *  a corrupted row should not throw on read). */
// SAFETY: parameter typed as Record<string, unknown> to accept raw SQLite rows; return cast to WorkflowRun because every field below is asserted individually from the typed row
export function rowToRun(row: Record<string, unknown>): WorkflowRun {
  // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `id` column is TEXT NOT NULL
  return {
    runID: row.id as string,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `name` column is TEXT NOT NULL
    name: row.name as string,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `status` column is TEXT with WorkflowStatus enum values
    status: row.status as WorkflowStatus,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `running` column is INTEGER
    running: row.running as number,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `succeeded` column is INTEGER
    succeeded: row.succeeded as number,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `failed` column is INTEGER
    failed: row.failed as number,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `current_phase` column is TEXT nullable
    currentPhase: (row.current_phase as string) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `parent_run_id` column is TEXT nullable
    parentRunID: (row.parent_run_id as string) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `args` column is TEXT JSON nullable; JSON.parse validated by try/catch
    args: (() => { try { return row.args ? JSON.parse(row.args as string) : undefined } catch (e) { log.debug({ err: e, runID: row.id }, "runs: row.args JSON.parse failed — returning undefined"); return undefined } })(),
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `script_sha` column is TEXT nullable
    scriptSha: (row.script_sha as string) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `agent_timeout_ms` column is INTEGER nullable
    agentTimeoutMs: (row.agent_timeout_ms as number) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `error` column is TEXT nullable
    error: (row.error as string) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `workspace` column is TEXT nullable
    workspace: (row.workspace as string) || undefined,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `time_created` column is INTEGER NOT NULL
    createdAt: row.time_created as number,
    // SAFETY: row comes from SELECT * on workflow_runs (typed schema); `time_updated` column is INTEGER NOT NULL
    updatedAt: row.time_updated as number,
  }
}

export class RunsRepository {
  constructor(private readonly db: Database) {}

  createRun(
    file: string,
    label: string,
    scriptSha: string,
    parentId?: string,
    workspace?: string,
    args?: unknown,
  ): string {
    const runID = generateRunID()
    const now = unixNow()
    // JSON-stringify args before insert so undefined → NULL (column is TEXT).
    // Anything else (object/array/primitive) round-trips through rowToRun's
    // JSON.parse. NULL means "no args" — resume() will pass null to the
    // guest, which is the historical pre-fix behavior.
    const argsJson = args === undefined ? null : JSON.stringify(args)
    this.db.run(
      `INSERT INTO workflow_runs (id, name, status, running, succeeded, failed, script_sha, parent_run_id, workspace, args, time_created, time_updated)
       VALUES (?, ?, 'running', 0, 0, 0, ?, ?, ?, ?, ?, ?)`,
      [runID, label, scriptSha, parentId ?? null, workspace ?? null, argsJson, now, now],
    )
    return runID
  }

  loadRun(runID: string): WorkflowRun | null {
    safeRunID(runID)
    // SAFETY: bun:sqlite query() returns unknown; Record<string, unknown> | undefined is the schema for SELECT * WHERE id=? result rows
    const row = this.db.query("SELECT * FROM workflow_runs WHERE id = ?").get(runID) as Record<string, unknown> | undefined
    return row ? rowToRun(row) : null
  }

  updateRunStatus(runID: string, status: WorkflowStatus, error?: string): void {
    safeRunID(runID)
    const now = unixNow()
    this.db.run(
      `UPDATE workflow_runs SET status = ?, error = ?, time_updated = ? WHERE id = ?`,
      [status, error ?? null, now, runID],
    )
  }

  // SAFETY: listRuns returns WorkflowRun[]; the type annotation reflects the mapped rows from SELECT * on workflow_runs
  listRuns(): WorkflowRun[] {
    // SAFETY: bun:sqlite query() returns unknown; Record<string, unknown>[] is the schema for SELECT * result rows
    const rows = this.db.query("SELECT * FROM workflow_runs ORDER BY time_created DESC").all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** Return only runs with status='running'. Used by recoverOrphanedWorkflows()
   *  on startup to find orphaned workflows that need to be marked as
   *  'paused' (journal replay possible) or 'crashed' (no journal). */
  // SAFETY: listRunningRuns returns WorkflowRun[]; the type annotation reflects the filtered rows from SELECT * WHERE status='running'
  listRunningRuns(): WorkflowRun[] {
    const rows = this.db
      // SAFETY: bun:sqlite query() returns unknown; Record<string, unknown>[] is the schema for SELECT * result rows
      .query("SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY time_created DESC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }
}
