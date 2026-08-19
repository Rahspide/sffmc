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
  // SAFETY: test fixture; `as any` is the documented escape hatch because the fake persistence implements only the 4 methods exercised by recoverOrphanedWorkflows
  return {
    listRunningRuns,
    hasJournalEvents,
    updateRunStatus,
    flushJournalSync,
  // @ts-expect-error - fake persistence intentionally omits methods required by WorkflowPersistence
  } as WorkflowPersistence
}

function makeFakeRuns(hasIds: Set<string>): WorkflowActivation<InternalRunEntry> {
  // SAFETY: test fixture; `as any` is the documented escape hatch because the fake runs-stub implements only the `has` method used by recoverOrphanedWorkflows
  return {
    has: (id: string) => hasIds.has(id),
  // @ts-expect-error - fake runs-stub intentionally omits methods required by WorkflowActivation
  } as WorkflowActivation<InternalRunEntry>
}

function makeRow(runID: string, createdAtSec: number): WorkflowRun {
  // SAFETY: test fixture; WorkflowRun is the documented row shape mapped from SELECT * on workflow_runs; partial fields are filled with deterministic defaults; `as any` is the documented escape hatch
  return {
    runID,
    name: "test",
    scriptSha: "abc",
    status: "running",
    createdAt: createdAtSec,
    args: [],
  // @ts-expect-error - WorkflowRun has additional required fields not exercised by the test
  } as WorkflowRun
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
    // SAFETY: persistence.updateRunStatus is a mock function with the documented WorkflowPersistence.updateRunStatus signature; cast re-states the tuple shape for the call args
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
    // SAFETY: persistence.updateRunStatus mock.calls[0] shape matches the documented (runID, status, reason) tuple; cast re-states the tuple shape for the call args
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
    // SAFETY: persistence.updateRunStatus mock.calls[0] shape matches the documented (runID, status, reason) tuple; cast re-states the tuple shape for the call args
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
    // SAFETY: persistence.updateRunStatus mock.calls is the documented (runID, status, reason) tuple array; cast re-states the array element shape for the Map construction
    const calls = (persistence.updateRunStatus as ReturnType<typeof mock>)
      .mock.calls as Array<[string, WorkflowStatus, string]>
    const byID = new Map(calls.map((c) => [c[0], c[1]]))
    expect(byID.get("r-grace")).toBe("paused")
    expect(byID.get("r-past-journal")).toBe("paused")
    expect(byID.get("r-past-crashed")).toBe("crashed")
  })
})
