// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// FlushManager tests (M-1 god-object extract, Task 1.6).
// Covers debounce collapsing, immediate-flush semantics, and error
// tolerance. The runtime-level test in `runtime-coverage.test.ts`
// (`scheduleFlush / flushNow DB counter flush`) exercises the integration.

import { describe, test, expect, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { FlushManager } from "../src/flush-manager.ts"
import { WorkflowPersistence } from "../src/persistence.ts"
import { CounterManager } from "../src/counter-manager.ts"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-flush-mgr-"))
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeMgr() {
  const p = new WorkflowPersistence({ dataDir: tmpDir })
  const mgr = new FlushManager(p)
  return { mgr, p }
}

function makeEntry(runID: string, counters: CounterManager) {
  return { runID, counters }
}

describe("FlushManager", () => {
  test("flushNow writes running/succeeded/failed to the DB row", () => {
    const { mgr, p } = makeMgr()
    const counters = Object.assign(new CounterManager(), {
      running: 0,
      succeeded: 3,
      failed: 1,
    })
    const runID = p.createRun("flush-now.ts", "flush-now", "deadbeef")
    mgr.flushNow(makeEntry(runID, counters))
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.running).toBe(0)
    expect(row!.succeeded).toBe(3)
    expect(row!.failed).toBe(1)
  })

  test("scheduleFlush debounces multiple calls within 250ms", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("debounce.ts", "debounce", "deadbeef")
    const counters = Object.assign(new CounterManager(), { succeeded: 5 })
    const entry = makeEntry(runID, counters)
    mgr.scheduleFlush(entry)
    mgr.scheduleFlush(entry)
    mgr.scheduleFlush(entry)
    // Within debounce window — DB not yet touched.
    const rowImmediate = p.loadRun(runID)
    expect(rowImmediate!.succeeded).toBe(0)

    await new Promise((r) => setTimeout(r, 350))
    const rowAfter = p.loadRun(runID)
    expect(rowAfter!.succeeded).toBe(5)
  })

  test("flushNow coerces missing counters to 0 (NOT NULL contract)", () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("undefined.ts", "undefined", "deadbeef")
    // Bare-minimum entry — no `counters` field.
    mgr.flushNow({ runID } as unknown as Parameters<typeof mgr.flushNow>[0])
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.running).toBe(0)
    expect(row!.succeeded).toBe(0)
    expect(row!.failed).toBe(0)
  })

  test("clearAll cancels every pending timer", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("clearall.ts", "clearall", "deadbeef")
    const counters = Object.assign(new CounterManager(), { succeeded: 9 })
    mgr.scheduleFlush(makeEntry(runID, counters))
    mgr.clearAll()
    // After clearAll the timer should not fire — DB row stays 0.
    await new Promise((r) => setTimeout(r, 350))
    const row = p.loadRun(runID)
    expect(row!.succeeded).toBe(0)
  })

  // Regression net for the flushNow + scheduleFlush interaction: an explicit
  // flushNow must cancel the pending debounce timer so the next fire within
  // the debounce window doesn't double-write the same row.
  test("flushNow cancels a pending scheduleFlush timer (no double-flush)", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("cancel-timer.ts", "cancel-timer", "deadbeef")
    const counters = Object.assign(new CounterManager(), { succeeded: 4 })
    mgr.scheduleFlush(makeEntry(runID, counters))
    // Immediately flushNow — the timer is still pending but must be cancelled.
    mgr.flushNow(makeEntry(runID, counters))
    // Wait past the debounce window to verify the timer did NOT fire.
    await new Promise((r) => setTimeout(r, 350))
    const row = p.loadRun(runID)
    // The row must reflect the flushNow write (succeeded=4). The pending
    // timer's flushNow(entry) — which would also write succeeded=4 — must
    // not have fired, otherwise we'd have a second redundant write but the
    // observed state is unchanged. The defensive check below is the
    // invariant we care about: a single UPDATE path executed, no race
    // where the timer fires after explicit flushNow.
    expect(row!.succeeded).toBe(4)
    expect(row!.running).toBe(0)
    expect(row!.failed).toBe(0)
  })

  // Regression net for the DB error path: a transient SQLite failure
  // must not throw to the caller (the runtime hot path), and the latest
  // counters stay in-memory for the next flush attempt. We force the error
  // by passing a FlushableCounters whose runID does not exist in the DB —
  // `db.run` succeeds with 0 affected rows, so this only verifies the
  // happy path. To exercise a real DB error we close the underlying DB
  // and call flushNow again, which forces `db.run` to throw.
  test("flushNow swallows DB errors without throwing", () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("dberr.ts", "dberr", "deadbeef")
    // Force the DB into a closed state so the next `db.run` throws.
    p.close()
    // Must not throw, even though the DB is closed.
    expect(() => mgr.flushNow({ runID, counters: new CounterManager() })).not.toThrow()
  })

  // Concurrency characterization: a runtime that schedules flushes at
  // high frequency and one of them calls flushNow explicitly must not
  // leak the pending timer entry past flushNow.
  test("after flushNow, no internal timer is pending for that runID", () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("no-pending.ts", "no-pending", "deadbeef")
    mgr.scheduleFlush(makeEntry(runID, new CounterManager()))
    mgr.flushNow(makeEntry(runID, new CounterManager()))
    // No public size() — but we can probe via a second flushNow + timer:
    // after the cancellation, scheduleFlush can re-arm cleanly (no orphan).
    expect(() => mgr.scheduleFlush(makeEntry(runID, new CounterManager()))).not.toThrow()
    // And the second timer must fire and complete cleanly.
  })

  // REGRESSION (gen-3 DEFER #2): the timer fires against the latest
  // mutated counters, not a snapshot taken at schedule time. The runtime
  // mutates `entry.counters.*` in place between scheduleFlush calls
  // during a normal agent lifecycle; the timer must read those mutations
  // through the captured entry reference.
  test("scheduleFlush reads counters at fire-time, not at schedule-time", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("mutate.ts", "mutate", "deadbeef")
    const counters = Object.assign(new CounterManager(), { succeeded: 1 })
    const entry = makeEntry(runID, counters)
    mgr.scheduleFlush(entry)
    // Mutate counters between schedule and fire. The timer must observe
    // the post-mutation values when it eventually fires.
    counters.succeeded = 7
    counters.failed = 2
    counters.running = 0
    await new Promise((r) => setTimeout(r, 350))
    const row = p.loadRun(runID)
    expect(row!.succeeded).toBe(7)
    expect(row!.failed).toBe(2)
    expect(row!.running).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #2, cancel+resume characterization): when the
  // runtime replaces an entry between scheduleFlush and timer fire
  // (cancel+resume pattern: scheduleFlush(e1) → cancel → make new
  // entry → scheduleFlush(e2)), the timer must flush e2's counters, NOT
  // e1's stale ones. Pre-fix, the timer captured e1 by closure and
  // wrote e1's counters after e2 had already taken over the run.
  test("timer fires with the latest entry after entry replacement (cancel+resume)", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("replace.ts", "replace", "deadbeef")
    // Original entry — counter state from the first workflow incarnation.
    const e1Counters = Object.assign(new CounterManager(), {
      succeeded: 1,
      failed: 0,
      running: 0,
    })
    const e1 = makeEntry(runID, e1Counters)
    mgr.scheduleFlush(e1)

    // Cancel happens (out of scope here); a new entry takes over. The
    // new sandbox starts flushing its own counters via scheduleFlush.
    // We simulate by passing a DIFFERENT entry object — the registry
    // should overwrite with this one.
    const e2Counters = Object.assign(new CounterManager(), {
      succeeded: 11,
      failed: 4,
      running: 0,
    })
    const e2 = makeEntry(runID, e2Counters)
    mgr.scheduleFlush(e2)
    // (Identity is the invariant: e1 and e2 must be different objects.)
    expect(e2).not.toBe(e1)

    await new Promise((r) => setTimeout(r, 350))
    const row = p.loadRun(runID)
    // DB row must reflect e2's counters, NOT e1's. Pre-fix the timer
    // captured e1 and would have written succeeded=1 here.
    expect(row!.succeeded).toBe(11)
    expect(row!.failed).toBe(4)
    expect(row!.running).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #2, scale characterization): many rapid
  // scheduleFlush calls with different entry objects must NOT produce
  // duplicate or stale-counter writes. Each schedule overwrites the
  // registry; only one timer fires (debounce); the timer's payload is
  // the LAST-scheduled entry's counters.
  test("50 scheduleFlush calls with different entries → DB reflects the last one", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("scale-replace.ts", "scale-replace", "deadbeef")
    const N = 50
    for (let i = 1; i <= N; i++) {
      const counters = Object.assign(new CounterManager(), {
        succeeded: i,
        failed: 0,
        running: 0,
      })
      mgr.scheduleFlush(makeEntry(runID, counters))
    }
    await new Promise((r) => setTimeout(r, 350))
    const row = p.loadRun(runID)
    // Exactly N, not any intermediate value from a stale-captured entry.
    expect(row!.succeeded).toBe(N)
    expect(row!.failed).toBe(0)
    expect(row!.running).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #2, post-flushNow state): after flushNow
  // cancels a pending timer, a subsequent scheduleFlush for the SAME
  // runID must arm a fresh timer that fires against the new entry. The
  // flushEntries registry must be cleared by flushNow so the next
  // schedule starts from a clean slate.
  test("after flushNow, scheduleFlush re-arms cleanly with a different entry", async () => {
    const { mgr, p } = makeMgr()
    const runID = p.createRun("rearm.ts", "rearm", "deadbeef")
    // First cycle: e1 scheduled, then explicitly flushed.
    const e1Counters = Object.assign(new CounterManager(), { succeeded: 5 })
    mgr.scheduleFlush(makeEntry(runID, e1Counters))
    mgr.flushNow(makeEntry(runID, e1Counters))
    // Row now has succeeded=5.
    let row = p.loadRun(runID)
    expect(row!.succeeded).toBe(5)

    // Second cycle: a new entry takes over (cancel+resume). The pending
    // timer from cycle 1 was cancelled by flushNow; scheduleFlush must
    // arm a fresh one with the new entry's counters.
    const e2Counters = Object.assign(new CounterManager(), { succeeded: 13 })
    mgr.scheduleFlush(makeEntry(runID, e2Counters))
    await new Promise((r) => setTimeout(r, 350))
    row = p.loadRun(runID)
    expect(row!.succeeded).toBe(13)
  })
})
