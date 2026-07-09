// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Run CRUD repository, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 5). Wraps the `workflow_runs` table with
// typed methods: createRun, loadRun, updateRunStatus, listRuns,
// listRunningRuns. The WorkflowPersistence class delegates to this
// repository while keeping its public API unchanged.

import { generateRunID } from "./runid.ts"
import { safeRunID, unixNow } from "@sffmc/utilities"
import type { WorkflowRun, WorkflowStatus } from "./types.ts"
import type { Database } from "bun:sqlite"

/** Map a workflow_runs row to the typed WorkflowRun shape.
 *  Args round-trip through JSON.parse (with try/catch fallback to
 *  undefined for malformed entries — the row was written by us, but
 *  a corrupted row should not throw on read). */
export function rowToRun(row: Record<string, unknown>): WorkflowRun {
  return {
    runID: row.id as string,
    name: row.name as string,
    status: row.status as WorkflowStatus,
    running: row.running as number,
    succeeded: row.succeeded as number,
    failed: row.failed as number,
    currentPhase: (row.current_phase as string) || undefined,
    parentRunID: (row.parent_run_id as string) || undefined,
    args: (() => { try { return row.args ? JSON.parse(row.args as string) : undefined } catch { return undefined } })(),
    scriptSha: (row.script_sha as string) || undefined,
    agentTimeoutMs: (row.agent_timeout_ms as number) || undefined,
    error: (row.error as string) || undefined,
    workspace: (row.workspace as string) || undefined,
    createdAt: row.time_created as number,
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

  listRuns(): WorkflowRun[] {
    const rows = this.db.query("SELECT * FROM workflow_runs ORDER BY time_created DESC").all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }

  /** Return only runs with status='running'. Used by recoverOrphanedWorkflows()
   *  on startup to find orphaned workflows that need to be marked as
   *  'paused' (journal replay possible) or 'crashed' (no journal). */
  listRunningRuns(): WorkflowRun[] {
    const rows = this.db
      .query("SELECT * FROM workflow_runs WHERE status = 'running' ORDER BY time_created DESC")
      .all() as Record<string, unknown>[]
    return rows.map(rowToRun)
  }
}
