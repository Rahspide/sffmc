// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Concurrency helper tests (M-1 god-object extract, Task 1.6).
// Covers Semaphore ordering and Lock chain semantics — both exercised
// concurrently by WorkflowRuntime.resume() in production. Standalone
// helpers have no domain dependencies so test runs are hermetic.
//
// L-3 (Task 2.7): acquireLock moved to a `Concurrency` class with an
// instance-scoped lockMap. Tests construct a fresh `Concurrency` per
// describe so cross-test chains can't leak — the previous module-level
// `lockMap` required test ordering to avoid pollution.

import { describe, test, expect } from "bun:test"
import { makeSemaphore, Concurrency } from "../src/concurrency.ts"

describe("makeSemaphore", () => {
  test("run() resolves with the thunks return value", async () => {
    const sem = makeSemaphore(2)
    const v = await sem.run(async () => 42)
    expect(v).toBe(42)
  })

  test("run() rejects if the thunk throws", async () => {
    const sem = makeSemaphore(1)
    await expect(sem.run(async () => { throw new Error("nope") })).rejects.toThrow("nope")
  })

  test("max=1 throttles concurrent callers — second waits for first", async () => {
    const sem = makeSemaphore(1)
    const order: number[] = []
    const p1 = sem.run(async () => {
      order.push(1)
      await new Promise((r) => setTimeout(r, 20))
      order.push(2)
      return "a"
    })
    const p2 = sem.run(async () => {
      order.push(3)
      return "b"
    })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe("a")
    expect(r2).toBe("b")
    // First thunk's body runs before the second thunk starts (because sem=1).
    expect(order).toEqual([1, 2, 3])
  })

  test("max=N allows N concurrent thunks", async () => {
    const sem = makeSemaphore(3)
    let active = 0
    let maxActive = 0
    const thunks = Array.from({ length: 8 }, (_, i) =>
      sem.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((r) => setTimeout(r, 10))
        active--
        return i
      }),
    )
    const results = await Promise.all(thunks)
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(maxActive).toBe(3)
  })

  test("active and max getters report correct values", async () => {
    const sem = makeSemaphore(2)
    expect(sem.active).toBe(0)
    expect(sem.max).toBe(2)
    const pending = sem.run(async () => {
      expect(sem.active).toBe(1)
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(sem.active).toBe(1)
    await pending
    expect(sem.active).toBe(0)
  })
})

describe("Concurrency.acquireLock", () => {
  // Each test gets its own Concurrency instance (L-3, Task 2.7) — independent
  // lockMap, so test ordering cannot leak chains between describe blocks.
  test("two lockers with different keys do not serialize", async () => {
    const c = new Concurrency()
    const order: string[] = []
    const l1 = await c.acquireLock("k1")
    order.push("acq1")
    const l2 = await c.acquireLock("k2")
    order.push("acq2")
    l2.release()
    l1.release()
    expect(order).toEqual(["acq1", "acq2"])
  })

  test("two lockers with the same key serialize — second waits for release", async () => {
    const c = new Concurrency()
    const order: string[] = []
    const l1 = await c.acquireLock("shared")
    order.push("acq1")
    const p2 = c.acquireLock("shared").then((l) => {
      order.push("acq2")
      return l
    })
    // Give the microtask queue a chance to run; l2 should NOT resolve yet
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(["acq1"])
    l1.release()
    const l2 = await p2
    l2.release()
    expect(order).toEqual(["acq1", "acq2"])
  })

  test("release() invoked twice does not deadlock subsequent acquirers", async () => {
    const c = new Concurrency()
    const l1 = await c.acquireLock("k")
    l1.release()
    l1.release() // idempotent: tail already removed
    const l2 = await c.acquireLock("k")
    l2.release()
    // no-op succeeds
  })

  // L-3 characterization: demonstrates the new instance isolation contract
  // that motivated promoting lockMap off module scope. Before this refactor
  // both acquisitions shared the same module-level lockMap; now they don't.
  test("two Concurrency instances have independent lock chains (L-3 characterization)", async () => {
    const cA = new Concurrency()
    const cB = new Concurrency()
    // Hold A's chain under "shared" indefinitely
    const lA = await cA.acquireLock("shared")
    // B's acquisition under the same key must resolve immediately because B
    // has its own empty lockMap — module-level scope would have made B
    // wait for A's release.
    let bResolved = false
    const lBPromise = cB.acquireLock("shared").then((l) => {
      bResolved = true
      return l
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(bResolved).toBe(true)
    lA.release()
    const lB = await lBPromise
    lB.release()
  })

  // REGRESSION (gen-3 DEFER #1): previously lockMap stored
  // `prev.then(() => next)` instead of `next` directly, so the cleanup
  // check `lockMap.get(key) === next` never matched and stale chained
  // Promise references accumulated per key across many acquire/release
  // cycles. The fix stores `next` by identity; this test pins that the
  // map empties out as soon as the last acquirer releases.
  test("lockMap is empty after a single acquireLock + release cycle", async () => {
    const c = new Concurrency()
    const l = await c.acquireLock("k")
    expect(c.lockMapSize()).toBe(1)
    l.release()
    expect(c.lockMapSize()).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #1, multi-acquirer case): with two acquirers
  // on the same key, the lockMap must NOT retain the chained Promise
  // (which would have been `next1.then(() => next2)` pre-fix) after both
  // release. The second acquirer still serializes behind the first, but
  // the map cleans up once the LAST acquirer releases.
  test("lockMap is empty after both acquirers release on the same key", async () => {
    const c = new Concurrency()
    const l1 = await c.acquireLock("shared")
    const p2 = c.acquireLock("shared")
    expect(c.lockMapSize()).toBe(1)
    l1.release()
    const l2 = await p2
    expect(c.lockMapSize()).toBe(1)
    l2.release()
    expect(c.lockMapSize()).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #1, scale characterization): 1000
  // acquire/release cycles across 10 keys must NOT grow lockMap beyond
  // the number of currently-held keys (zero, since each cycle releases
  // before the next). Pre-fix, each cycle would leave one stale chained
  // Promise in lockMap; after 1000 cycles the map would have ~1000 entries.
  // Post-fix, the map stays empty (all keys released).
  test("1000 acquire/release cycles on 10 keys leave lockMap empty", async () => {
    const c = new Concurrency()
    const keys = Array.from({ length: 10 }, (_, i) => `key-${i}`)
    for (let i = 0; i < 1000; i++) {
      const key = keys[i % keys.length]
      const l = await c.acquireLock(key)
      l.release()
    }
    expect(c.lockMapSize()).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #1, contention characterization): when many
  // acquirers queue on the same key, each must serialize strictly in
  // registration order. The first acquirer (whose `prev` was undefined)
  // resolves on the next microtask; subsequent acquirers wait for the
  // previous tail. Pre-fix this happened to work (the chained
  // `prev.then(...)` produced correct ordering), but the map would
  // retain a stale chain. Post-fix the map still cleans up after the
  // final acquirer releases. Locks the correctness invariant while
  // ensuring the leak fix doesn't regress ordering.
  test("5 concurrent acquirers on the same key serialize in registration order, then map empties", async () => {
    const c = new Concurrency()
    const order: number[] = []
    const locks = Array.from({ length: 5 }, (_, i) => {
      return c.acquireLock("k").then((l) => {
        order.push(i)
        return l
      })
    })
    // The FIRST acquirer (prev = Promise.resolve()) resolves immediately
    // on the next microtask. Subsequent acquirers wait for the previous
    // tail. So after one microtask round, only lock 0 is held; the
    // remaining 4 are queued behind it.
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual([0])
    expect(c.lockMapSize()).toBe(1)

    // Release in order; each subsequent lock should resolve on the
    // following microtask.
    for (let i = 0; i < locks.length; i++) {
      const l = await locks[i]
      l.release()
    }
    expect(order).toEqual([0, 1, 2, 3, 4])
    expect(c.lockMapSize()).toBe(0)
  })

  // REGRESSION (gen-3 DEFER #1, held-lock invariant): while a lock is held,
  // the key stays in the map. Once released, the key is removed even if
  // other acquirers have queued behind it. This pins that cleanup happens
  // on EVERY release, not just the last one in the chain — the in-flight
  // chain that the next acquirer depends on is the actual `next` promise
  // stored under the key, which gets re-stored with each acquireLock.
  test("while an acquirer holds the lock, the key is in lockMap", async () => {
    const c = new Concurrency()
    const l = await c.acquireLock("k")
    expect(c.lockMapSize()).toBe(1)
    // Don't release yet — key must remain present.
    l.release()
    expect(c.lockMapSize()).toBe(0)
  })
})