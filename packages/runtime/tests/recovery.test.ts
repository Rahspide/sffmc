// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Regression net for the `recoverOrphanedWorkflows` module-level
// function, extracted from `runtime.ts` in the v0.16.0-SOLID wave 2
// god-decomposition. The function is pure over its `RecoveryDeps`
// argument + `gracePeriodMs` value — no `this` runtime reference.
// These tests exercise the classification logic in isolation by
// supplying a fake `WorkflowPersistence` + `WorkflowActivation` and
// asserting which status each orphan receives.

import { describe, test, expect, mock, beforeEach } from "bun:test"
import { recoverOrphanedWorkflows } from "../src/recovery.ts"
import type { WorkflowPersistence } from "../src/persistence.ts"
import type { WorkflowActivation } from "../src/activation.ts"
import type { InternalRunEntry } from "../src/internal-run-entry.ts"
import type { WorkflowRun, WorkflowStatus } from "../src/types.ts"

// --- fake persistence --------------------------------------------------------

interface StatusCall {
  runID: string
  status: WorkflowStatus
  error?: string
}

function makeFakePersistence(opts: {
  rows: WorkflowRun[]
  /** runID → has journal events on disk? */
  hasJournal: Record<string, boolean>
}): WorkflowPersistence {
  const statusCalls: StatusCall[] = []
  const listRunningRuns = mock(() => opts.rows)
  const hasJournalEvents = mock(async (runID: string) =>
    Boolean(opts.hasJournal[runID]),
  )
  const updateRunStatus = mock(
    (runID: string, status: WorkflowStatus, error?: string) => {
      statusCalls.push({ runID, status, error })
    },
  )
  const flushJournalSync = mock(() => {})

  // We only touch these 4 methods in the recovery path; cast for type.
  return {
    listRunningRuns,
    hasJournalEvents,
    updateRunStatus,
    flushJournalSync,
  } as unknown as WorkflowPersistence
}

function makeFakeRuns(hasIds: Set<string>): WorkflowActivation<InternalRunEntry> {
  return {
    has: (id: string) => hasIds.has(id),
  } as unknown as WorkflowActivation<InternalRunEntry>
}

function makeRow(runID: string, createdAtSec: number): WorkflowRun {
  return {
    runID,
    name: "test",
    scriptSha: "abc",
    status: "running",
    createdAt: createdAtSec,
    args: [],
  } as unknown as WorkflowRun
}

// --- tests -------------------------------------------------------------------

let fakeNow: number

beforeEach(() => {
  // Anchor "now" at a fixed timestamp so age calculations are stable.
  fakeNow = 1_700_000_000_000
  const origNow = Date.now
  Date.now = () => fakeNow
  return () => {
    Date.now = origNow
  }
})

describe("recovery.recoverOrphanedWorkflows", () => {
  test("no running rows → no status writes, one flush", async () => {
    const persistence = makeFakePersistence({ rows: [], hasJournal: {} })
    const runs = makeFakeRuns(new Set())
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    expect(persistence.updateRunStatus).not.toHaveBeenCalled()
    expect(persistence.flushJournalSync).toHaveBeenCalledTimes(1)
  })

  test("row within grace period → marked 'paused' regardless of journal", async () => {
    // Age = 5s, grace = 60s
    const row = makeRow("r-1", (fakeNow - 5_000) / 1000)
    const persistence = makeFakePersistence({
      rows: [row],
      hasJournal: {}, // empty journal — still paused within grace
    })
    const runs = makeFakeRuns(new Set())
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    expect(persistence.updateRunStatus).toHaveBeenCalledTimes(1)
    const call = (persistence.updateRunStatus as ReturnType<typeof mock>)
      .mock.calls[0] as [string, WorkflowStatus, string]
    expect(call[0]).toBe("r-1")
    expect(call[1]).toBe("paused")
    expect(call[2]).toContain("within grace period")
    expect(persistence.hasJournalEvents).not.toHaveBeenCalled()
  })

  test("row past grace with journal → 'paused' (resumable from journal)", async () => {
    // Age = 120s, grace = 60s, journal present
    const row = makeRow("r-2", (fakeNow - 120_000) / 1000)
    const persistence = makeFakePersistence({
      rows: [row],
      hasJournal: { "r-2": true },
    })
    const runs = makeFakeRuns(new Set())
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    const call = (persistence.updateRunStatus as ReturnType<typeof mock>)
      .mock.calls[0] as [string, WorkflowStatus, string]
    expect(call[1]).toBe("paused")
    expect(call[2]).toContain("resumable from journal")
  })

  test("row past grace with no journal → 'crashed'", async () => {
    // Age = 120s, grace = 60s, no journal
    const row = makeRow("r-3", (fakeNow - 120_000) / 1000)
    const persistence = makeFakePersistence({
      rows: [row],
      hasJournal: {},
    })
    const runs = makeFakeRuns(new Set())
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    const call = (persistence.updateRunStatus as ReturnType<typeof mock>)
      .mock.calls[0] as [string, WorkflowStatus, string]
    expect(call[1]).toBe("crashed")
    expect(call[2]).toContain("no journal to recover")
  })

  test("row that is in the live in-memory registry is skipped (belt-and-suspenders)", async () => {
    const row = makeRow("r-live", (fakeNow - 5_000) / 1000)
    const persistence = makeFakePersistence({ rows: [row], hasJournal: {} })
    const runs = makeFakeRuns(new Set(["r-live"])) // NOT an orphan
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    expect(persistence.updateRunStatus).not.toHaveBeenCalled()
    // The flush still runs (one per call, regardless of how many rows
    // were classified).
    expect(persistence.flushJournalSync).toHaveBeenCalledTimes(1)
  })

  test("mixed batch: 3 rows, each gets its own classification in one pass", async () => {
    const nowSec = fakeNow / 1000
    const rows = [
      makeRow("r-grace", nowSec - 5), // within grace
      makeRow("r-past-journal", nowSec - 120), // past grace, has journal
      makeRow("r-past-crashed", nowSec - 120), // past grace, no journal
    ]
    const persistence = makeFakePersistence({
      rows,
      hasJournal: { "r-past-journal": true },
    })
    const runs = makeFakeRuns(new Set())
    await recoverOrphanedWorkflows({ persistence, runs }, 60_000)
    expect(persistence.updateRunStatus).toHaveBeenCalledTimes(3)
    const calls = (persistence.updateRunStatus as ReturnType<typeof mock>)
      .mock.calls as Array<[string, WorkflowStatus, string]>
    const byID = new Map(calls.map((c) => [c[0], c[1]]))
    expect(byID.get("r-grace")).toBe("paused")
    expect(byID.get("r-past-journal")).toBe("paused")
    expect(byID.get("r-past-crashed")).toBe("crashed")
  })
})
