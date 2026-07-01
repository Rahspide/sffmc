// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// TDD interface tests for WorkflowActivation — extracted from WorkflowRuntime
// (M-1 god-object refactor, Task 1.5).
//
// The brief's sketched interface (`WorkflowScheduler.enqueue / cancel / pending`)
// didn't match the actual runtime.ts concern. The real surface in runtime.ts is
// the `private runs = new Map<string, InternalRunEntry>()` (line 209) — an
// activation REGISTRY, not a time-based scheduler. There is no cron, no queue
// depth, no scheduling logic anywhere in runtime.ts; what exists is a Map that
// holds in-flight `InternalRunEntry` objects and is mutated by:
//
//   - start()                 → runs.set(runID, entry)   [line 377]
//   - status()                → runs.get(runID)          [line 387]
//   - wait()                  → runs.get(runID)          [line 430]
//   - cancel()                → runs.get + runs.delete   [lines 466, 479]
//   - list()                  → for-of runs              [line 490]
//   - resume()                → runs.get + runs.set      [lines 504, 545]
//   - close()                 → for-of + runs.clear      [lines 563, 575]
//   - recoverOrphanedWorkflows() → runs.has             [line 606]
//   - startChildWorkflow()    → runs.set                [line 1124]
//   - completeRun()           → runs.delete             [line 1152]
//   - failRun()               → runs.delete             [line 1171]
//
// The brief's `cancel(runId)` collapses cancel-orchestration (DB update,
// event emit, outcome cache write) into a single Map.delete — but those
// orchestration concerns live on WorkflowRuntime (events, persistence,
// completedOutcomes), not on the registry. The class therefore exposes
// only the Map-shaped concern:
//
//   register(runID, entry)    — was runs.set()         (start, resume, child)
//   get(runID)                — was runs.get()         (status, wait, cancel, resume-live)
//   release(runID)            — was runs.delete()      (cancel, completeRun, failRun)
//   has(runID)                — was runs.has()         (recoverOrphanedWorkflows)
//   clear()                   — was runs.clear()       (close)
//   iter()                    — was for-of runs        (list, close)
//   pending()                 — was [...runs.keys()]   (observability; brief hint)
//   size()                    — was runs.size          (test/diagnostic surface)
//
// Class name `WorkflowActivation` (not `WorkflowScheduler`) — there is no
// scheduling in runtime.ts; this is a registry of *active* in-flight runs.

import { describe, test, expect } from "bun:test"
import { WorkflowActivation } from "../src/activation.ts"

interface FakeEntry {
  runID: string
  name: string
  status: string
}

function makeFakeEntry(runID: string, name = "test"): FakeEntry {
  return { runID, name, status: "running" }
}

describe("WorkflowActivation — initial state", () => {
  test("starts empty", () => {
    const a = new WorkflowActivation<FakeEntry>()
    expect(a.size()).toBe(0)
    expect(a.pending()).toEqual([])
  })

  test("iter() yields nothing when empty", () => {
    const a = new WorkflowActivation<FakeEntry>()
    expect([...a.iter()]).toEqual([])
  })
})

describe("WorkflowActivation — register()", () => {
  test("register(runID, entry) adds to registry", () => {
    const a = new WorkflowActivation<FakeEntry>()
    const e = makeFakeEntry("wf_a")
    a.register("wf_a", e)
    expect(a.size()).toBe(1)
    expect(a.get("wf_a")).toBe(e)
  })

  test("register overwrites previous entry for same runID", () => {
    // resume() after cancel re-registers under the same runID (the
    // previous entry was released). The Map shape preserves the
    // last-write-wins semantics from runtime.ts.
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a", "first"))
    const second = makeFakeEntry("wf_a", "second")
    a.register("wf_a", second)
    expect(a.get("wf_a")).toBe(second)
    expect(a.size()).toBe(1)
  })

  test("register accepts arbitrary entry shape (generic V)", () => {
    // The entry shape is parameterized so the registry can hold
    // InternalRunEntry (rich) or test fixtures (minimal). Type-only test;
    // relies on bun:test's typecheck via the production call sites.
    const a = new WorkflowActivation<{ runID: string }>()
    a.register("wf_x", { runID: "wf_x" })
    expect(a.get("wf_x")?.runID).toBe("wf_x")
  })
})

describe("WorkflowActivation — get() / has()", () => {
  test("get returns undefined for unknown runID", () => {
    const a = new WorkflowActivation<FakeEntry>()
    expect(a.get("wf_unknown")).toBeUndefined()
  })

  test("has returns true iff get would return a value", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    expect(a.has("wf_a")).toBe(true)
    expect(a.has("wf_b")).toBe(false)
  })
})

describe("WorkflowActivation — release()", () => {
  test("release removes the entry", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    a.release("wf_a")
    expect(a.get("wf_a")).toBeUndefined()
    expect(a.size()).toBe(0)
  })

  test("release is a no-op on unknown runID", () => {
    // Matches Map.delete semantics — does not throw on missing keys.
    // runtime.ts:479 (cancel), 1152 (completeRun), 1171 (failRun) all
    // assume this no-throw behavior.
    const a = new WorkflowActivation<FakeEntry>()
    expect(() => a.release("wf_ghost")).not.toThrow()
    expect(a.size()).toBe(0)
  })
})

describe("WorkflowActivation — clear()", () => {
  test("clear drops every entry", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    a.register("wf_b", makeFakeEntry("wf_b"))
    a.register("wf_c", makeFakeEntry("wf_c"))
    a.clear()
    expect(a.size()).toBe(0)
    expect(a.pending()).toEqual([])
  })

  test("clear on empty registry is a no-op", () => {
    const a = new WorkflowActivation<FakeEntry>()
    expect(() => a.clear()).not.toThrow()
  })
})

describe("WorkflowActivation — iter()", () => {
  test("iter yields [runID, entry] pairs (matches for-of Map pattern)", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a", "alpha"))
    a.register("wf_b", makeFakeEntry("wf_b", "beta"))
    const pairs = [...a.iter()].map(([id, e]) => [id, e.name] as const)
    // Map iteration order is insertion order; expect same.
    expect(pairs).toEqual([
      ["wf_a", "alpha"],
      ["wf_b", "beta"],
    ])
  })

  test("iter on empty registry yields nothing", () => {
    const a = new WorkflowActivation<FakeEntry>()
    expect([...a.iter()]).toEqual([])
  })
})

describe("WorkflowActivation — pending()", () => {
  test("pending() returns runIDs in registration order", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    a.register("wf_b", makeFakeEntry("wf_b"))
    a.register("wf_c", makeFakeEntry("wf_c"))
    expect(a.pending()).toEqual(["wf_a", "wf_b", "wf_c"])
  })

  test("pending() reflects post-release state", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    a.register("wf_b", makeFakeEntry("wf_b"))
    a.release("wf_a")
    expect(a.pending()).toEqual(["wf_b"])
  })

  test("pending() returns readonly view (caller cannot mutate registry)", () => {
    const a = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    const view = a.pending()
    // `pending()` returns `readonly string[]`. Mutating the returned array
    // must not affect the registry (we make a fresh copy).
    expect(() => {
      ;(view as string[]).push("wf_hacked")
    }).not.toThrow() // .push on readonly is a TS error but allowed at runtime on the array
    expect(a.pending()).toEqual(["wf_a"]) // registry unchanged
  })
})

describe("WorkflowActivation — registry independence", () => {
  test("two WorkflowActivation instances have isolated state", () => {
    const a = new WorkflowActivation<FakeEntry>()
    const b = new WorkflowActivation<FakeEntry>()
    a.register("wf_a", makeFakeEntry("wf_a"))
    expect(b.size()).toBe(0)
    expect(b.get("wf_a")).toBeUndefined()
    b.register("wf_a", makeFakeEntry("wf_a", "b-version"))
    expect(a.get("wf_a")?.name).toBe("test")
    expect(b.get("wf_a")?.name).toBe("b-version")
  })
})