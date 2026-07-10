// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Orphaned workflow recovery, extracted from WorkflowRuntime per the
// v0.16.0-SOLID extension (Wave 2 of the god-decomposition). On
// startup, any run left in 'running' status after a process restart
// is orphaned — its in-memory state is gone but its DB row is still
// marked running. This module classifies each orphan as either
// `paused` (resumable; user gets to decide whether to `resume()`
// it) or `crashed` (no journal to recover from; effectively dead).
//
// Why a module-level function (not a class): the function holds no
// state. Each invocation takes a `RecoveryDeps` bag + a `gracePeriodMs`
// value and runs to completion. A class would add boilerplate
// without a corresponding benefit (no fields, no state machine).
//
// Lock recovery is N/A — the `Concurrency` instance's lockMap is
// in-process only (lives on the runtime's `this.concurrency`, not
// on disk); there is no on-disk lock to recover.

import { createLogger } from "@sffmc/utilities"
import type { WorkflowPersistence } from "./persistence.ts"
import type { WorkflowActivation } from "./activation.ts"
import type { InternalRunEntry } from "./internal-run-entry.ts"

const log = createLogger("workflow:recovery")

/** Narrow dependency surface the recovery function needs. The
 *  runtime injects the real `WorkflowPersistence` + `WorkflowActivation`
 *  at construction time; tests pass fakes to exercise classification
 *  in isolation. */
export interface RecoveryDeps {
  /** Persistence — `listRunningRuns`, `hasJournalEvents`,
   *  `updateRunStatus`, `flushJournalSync`. */
  persistence: WorkflowPersistence
  /** Live-run registry — used to skip rows that are NOT orphans
   *  (e.g. a run that was just started in another process but is
   *  still in this process's `this.runs` map). */
  runs: WorkflowActivation<InternalRunEntry>
}

/** Recover orphaned workflows on startup.
 *
 *  For each row with status='running' that is NOT in the live
 *  in-memory registry:
 *
 *  - If the row's age is within `gracePeriodMs`, mark it `paused`.
 *    The user gets to decide whether to `resume()` it.
 *  - If the row is past the grace period:
 *    - mark `paused` if the journal has events (resumable from
 *      the journal), or
 *    - mark `crashed` if the journal is empty (no way to recover).
 *
 *  `gracePeriodMs` is read at call time (not at construction) so
 *  tests that mutate it via `setGracePeriodMs()` between calls
 *  observe the updated value.
 *
 *  After the loop, `flushJournalSync()` is called once so the
 *  classification writes hit disk before the runtime accepts new
 *  work. */
export async function recoverOrphanedWorkflows(
  deps: RecoveryDeps,
  gracePeriodMs: number,
): Promise<void> {
  const rows = deps.persistence.listRunningRuns()
  const nowMs = Date.now()
  for (const row of rows) {
    // Belt-and-suspenders: in-memory live runs can't be orphaned.
    if (deps.runs.has(row.runID)) continue
    const ageMs = nowMs - (row.createdAt * 1000)
    if (ageMs <= gracePeriodMs) {
      // Within grace: always paused. User gets to decide.
      deps.persistence.updateRunStatus(
        row.runID,
        "paused",
        `Process restarted — within grace period (${Math.round(ageMs)}ms <= ${gracePeriodMs}ms); resumable`,
      )
      continue
    }
    const hasJournal = await deps.persistence.hasJournalEvents(row.runID)
    if (hasJournal) {
      deps.persistence.updateRunStatus(
        row.runID,
        "paused",
        `Process restarted — past grace period (${Math.round(ageMs)}ms > ${gracePeriodMs}ms); resumable from journal`,
      )
    } else {
      deps.persistence.updateRunStatus(
        row.runID,
        "crashed",
        `Process restarted — past grace period (${Math.round(ageMs)}ms) and no journal to recover`,
      )
    }
  }
  deps.persistence.flushJournalSync()
  log.debug(
    `recoverOrphanedWorkflows: classified ${rows.length} running row(s) (gracePeriodMs=${gracePeriodMs})`,
  )
}
