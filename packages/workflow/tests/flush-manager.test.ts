// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

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
})
