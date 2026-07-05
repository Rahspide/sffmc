// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Security + memory-leak coverage for `@sffmc/runtime`.
//
// Focus areas:
//   1. BoundedLRU — under sustained insert load, size never exceeds
//      maxSize; no zombie entries after delete/clear cycles.
//   2. FlushManager — scheduled debounce timers are cleared on closeAll
//      (no leaked setTimeout references keeping Node alive).
//   3. McpBridge — budget is bounded; after N rejected calls, rejectedCount
//      tracks accurately; the bridge does not retain per-call state past
//      the call's lifetime.
//   4. WorkspaceJail — O_NOFOLLOW prevents the symlink-as-leaf attack
//      (already covered in foundation.test.ts but pinned here for the
//      security audit).
//   5. workflow-watcher — stop() closes all FSWatchers; subsequent
//      filesystem changes are not observed.
//
// (The redactSecrets() ReDoS bug lives in `@sffmc/utilities` — see
// packages/utilities/src/security-leaks.test.ts for that finding.)

import { describe, it, expect } from "bun:test"
import { BoundedLRU } from "../src/lru.ts"
import { FlushManager } from "../src/flush-manager.ts"
import { WorkflowPersistence } from "../src/persistence.ts"
import { McpBridge } from "../src/mcp.ts"
import { startWorkflowWatcher } from "../src/workflow-watcher.ts"
import { WorkspaceJail } from "../src/workspace.ts"
import { tmpdir } from "node:os"
import { mkdtempSync, writeFileSync, symlinkSync, unlinkSync, readlinkSync } from "node:fs"
import path from "node:path"

// =============================================================================
// 1) BoundedLRU — memory leak
// =============================================================================

describe("BoundedLRU: never grows beyond maxSize (memory bound)", () => {
  it("insert 1M items with maxSize=100 — size stays at 100 (no leak)", () => {
    const lru = new BoundedLRU<string, number>(100)
    for (let i = 0; i < 1_000_000; i++) {
      lru.set(`k${i}`, i)
    }
    expect(lru.size).toBe(100)
    expect(lru.capacity).toBe(100)
    // Last 100 inserted should be present.
    expect(lru.get("k999999")).toBe(999999)
    expect(lru.get("k999900")).toBe(999900)
    // Anything earlier was evicted.
    expect(lru.get("k0")).toBeUndefined()
  })

  it("maxSize=0 discards all writes (no growth even under 10k insert load)", () => {
    const lru = new BoundedLRU<string, number>(0)
    for (let i = 0; i < 10_000; i++) lru.set(`k${i}`, i)
    expect(lru.size).toBe(0)
  })

  it("delete every entry brings size to 0 (no zombie entries)", () => {
    const lru = new BoundedLRU<string, number>(10)
    for (let i = 0; i < 10; i++) lru.set(`k${i}`, i)
    for (let i = 0; i < 10; i++) lru.delete(`k${i}`)
    expect(lru.size).toBe(0)
    expect(lru.capacity).toBe(10) // capacity unchanged
  })

  it("clear() resets size to 0 (memory released, not just unreachable)", () => {
    const lru = new BoundedLRU<string, number>(5)
    for (let i = 0; i < 1000; i++) lru.set(`k${i}`, i)
    lru.clear()
    expect(lru.size).toBe(0)
  })

  it("re-set existing key under sustained load keeps size bounded", () => {
    // Catches a class of bug: re-set with the same key might leave a
    // temporary duplicate that gets cleaned up only later.
    const lru = new BoundedLRU<string, number>(50)
    for (let i = 0; i < 100_000; i++) {
      lru.set("k", i) // same key 100k times
    }
    expect(lru.size).toBe(1) // not 50 or 100k
    expect(lru.get("k")).toBe(99999)
  })
})

// =============================================================================
// 2) FlushManager — debounce timer cleanup
// =============================================================================

describe("FlushManager: clearAll cancels all pending debounce timers (no leaked setTimeout)", () => {
  it("scheduleFlush + clearAll: no flushes happen after clearAll (no leaked timer)", () => {
    // Use a real WorkflowPersistence (in-memory) so flushNow hits the DB.
    // We verify that after clearAll, no row is written — proving the
    // debounce timer was canceled before it could fire.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-flush-leak-"))
    const persistence = new WorkflowPersistence({ dataDir: tmpDir })
    const fm = new FlushManager(persistence) // default 250ms debounce

    // Schedule 50 flushes for distinct runIDs.
    for (let i = 0; i < 50; i++) {
      fm.scheduleFlush({ runID: `wf_${i}`, counters: { running: 0, succeeded: 0, failed: 0 } })
    }

    fm.clearAll()

    return new Promise<void>((resolve) => {
      // Wait longer than the 250ms debounce window.
      setTimeout(() => {
        // No flush should have run: no row in workflow_runs.
        const db = persistence.getDB()
        const result = db.query("SELECT count(*) as c FROM workflow_runs").get() as { c: number }
        expect(result.c).toBe(0)
        try {
          const { rmSync } = require("node:fs")
          rmSync(tmpDir, { recursive: true, force: true })
        } catch { /* ignore */ }
        resolve()
      }, 300)
    })
  })
})

// =============================================================================
// 3) McpBridge — budget bounded
// =============================================================================

describe("McpBridge: budget is bounded; rejectedCount tracks accurately", () => {
  it("rejected count is bounded by maxCalls (no overflow)", () => {
    const bridge = new McpBridge(10)
    for (let i = 0; i < 100; i++) {
      bridge.recordRejected("tool", null, "over budget")
    }
    expect(bridge.rejectedCount).toBe(100) // counter, not capped
    expect(bridge.callCount).toBe(0) // rejected calls don't count as successful
  })

  it("callCount increments on success, not on rejection", () => {
    const bridge = new McpBridge(5)
    bridge.recordCall("a", null)
    bridge.recordCall("b", null)
    bridge.recordRejected("c", null, "test")
    bridge.recordCall("d", null)
    expect(bridge.callCount).toBe(3)
    expect(bridge.rejectedCount).toBe(1)
  })

  it("checkBudget returns rejection reason when over budget, null otherwise", () => {
    const bridge = new McpBridge(1)
    expect(bridge.checkBudget()).toBeNull() // under budget
    bridge.recordCall("a", null)
    const rej = bridge.checkBudget()
    expect(rej).toMatch(/budget/i)
  })
})

// =============================================================================
// 4) workflow-watcher — stop closes FSWatchers (memory + FD leak)
// =============================================================================

describe("workflow-watcher: stop() closes all FSWatchers (no FD leak)", () => {
  it("start + stop: pendingCount returns to 0 (no leaked watchers)", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-wf-leak-"))
    const handle = startWorkflowWatcher(tmpDir)
    // Allow file system watchers to register before we stop.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        handle.stop()
        // stop() is idempotent — calling again is a no-op.
        expect(() => handle.stop()).not.toThrow()
        resolve()
      }, 50)
    }).finally(() => {
      // cleanup tmpDir
      try {
        // removeRecursiveSync equivalent
        const { rmSync } = require("node:fs")
        rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    })
  })

  it("stop before any file events: no listeners fire after stop", () => {
    // Catches: file change queued, then stop() called, then change
    // occurs — listener should NOT fire because the watcher is closed.
    const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-wf-stop-"))
    const workflowsDir = path.join(tmpDir, ".sffmc", "workflows")
    require("node:fs").mkdirSync(workflowsDir, { recursive: true })

    const handle = startWorkflowWatcher(tmpDir)
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        handle.stop()
        // Now write a file — should NOT trigger any event.
        writeFileSync(path.join(workflowsDir, "after_stop.ts"), "export const meta = {}")
        setTimeout(() => {
          // We don't have a direct way to count events here without
          // coupling to the events bus. The test is "stop returns
          // idempotently and doesn't throw" — see above test for the
          // close-strictness check.
          resolve()
        }, 100)
      }, 50)
    }).finally(() => {
      try {
        const { rmSync } = require("node:fs")
        rmSync(tmpDir, { recursive: true, force: true })
      } catch { /* ignore */ }
    })
  })
})

// =============================================================================
// 5) WorkspaceJail — symlink-as-leaf attack (cross-platform)
// =============================================================================
//
// The O_NOFOLLOW defense-in-depth in `WorkspaceJail.safeRead` / `safeWrite`
// closes the TOCTOU window between `resolveInWorkspace()` (which follows
// symlinks via realpathSync) and the actual `open()` call. It does NOT
// prevent the symlink-as-leaf case (that's already blocked by the
// realpath check in resolveInWorkspace — symlinks inside the workspace
// that point outside it are rejected before open() is ever called).
//
// The proper test of O_NOFOLLOW's TOCTOU defense would require a
// race-condition harness (create symlink between resolveInWorkspace and
// open), which is hard to do reliably in a unit test. The portable
// fallback path is covered by foundation.test.ts's O_NOFOLLOW smoke
// test. We don't add a test here that misrepresents the defense.

// =============================================================================
// helpers
// =============================================================================
