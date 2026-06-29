// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// TDD interface tests for OutcomeStore — extracted from WorkflowRuntime
// (M-1 god-object refactor, Task 1.4).
//
// The brief's sketched interface (put/take read+delete/size method) didn't
// match the existing characterization contract in runtime-external-api.test.ts:
// the "late wait() after settle returns the cached outcome" test pins a
// non-destructive read for the second-call path, so `get()` MUST exist in
// addition to `take()`. Inspection of runtime.ts showed the existing field
// is `BoundedLRU<string, WorkflowOutcome>` with capacity wired from
// `RuntimeOpts.completedOutcomesCacheSize ?? resolveOutcomesCacheSize()`.
// OutcomeStore is a thin domain wrapper that re-exposes the bounded LRU
// semantics with workflow-friendly naming (put/get/take) while keeping the
// non-destructive read for the late-wait path.

import { describe, test, expect } from "bun:test"
import { OutcomeStore } from "../src/outcome-store.ts"

describe("OutcomeStore — put / get", () => {
  test("put + get round-trip returns the stored value", () => {
    const s = new OutcomeStore<string, number>(10)
    s.put("a", 1)
    expect(s.get("a")).toBe(1)
  })

  test("get on a missing key returns undefined", () => {
    const s = new OutcomeStore<string, number>(10)
    expect(s.get("missing")).toBeUndefined()
  })

  test("get is non-destructive — multiple reads return the same value", () => {
    // Pins the late-wait() contract: a second wait() after settle must
    // still resolve to the cached outcome (see runtime-external-api.test.ts
    // "late wait() after settle returns the cached outcome").
    const s = new OutcomeStore<string, number>(10)
    s.put("run-1", 42)
    expect(s.get("run-1")).toBe(42)
    expect(s.get("run-1")).toBe(42)
    expect(s.get("run-1")).toBe(42)
  })
})

describe("OutcomeStore — take", () => {
  test("take returns the value and removes the entry", () => {
    const s = new OutcomeStore<string, number>(10)
    s.put("a", 1)
    expect(s.take("a")).toBe(1)
    expect(s.take("a")).toBeUndefined()
    expect(s.get("a")).toBeUndefined()
  })

  test("take on a missing key returns undefined (no-op)", () => {
    const s = new OutcomeStore<string, number>(10)
    expect(s.take("missing")).toBeUndefined()
  })
})

describe("OutcomeStore — size", () => {
  test("starts at 0", () => {
    const s = new OutcomeStore<string, number>(10)
    expect(s.size).toBe(0)
  })

  test("reflects current count after put / take", () => {
    const s = new OutcomeStore<string, number>(10)
    s.put("a", 1)
    expect(s.size).toBe(1)
    s.put("b", 2)
    expect(s.size).toBe(2)
    s.take("a")
    expect(s.size).toBe(1)
    s.clear()
    expect(s.size).toBe(0)
  })
})

describe("OutcomeStore — capacity and eviction", () => {
  test("capacity returns the configured max", () => {
    expect(new OutcomeStore<string, number>(7).capacity).toBe(7)
    expect(new OutcomeStore<string, number>(500).capacity).toBe(500)
    expect(new OutcomeStore<string, number>(0).capacity).toBe(0)
  })

  test("evicts oldest entries when over capacity (insertion order)", () => {
    const s = new OutcomeStore<string, number>(2)
    s.put("a", 1)
    s.put("b", 2)
    s.put("c", 3) // evicts "a"
    expect(s.size).toBe(2)
    expect(s.get("a")).toBeUndefined()
    expect(s.get("b")).toBe(2)
    expect(s.get("c")).toBe(3)
  })

  test("size=0 accepts writes but discards them", () => {
    const s = new OutcomeStore<string, number>(0)
    s.put("a", 1)
    s.put("b", 2)
    expect(s.size).toBe(0)
    expect(s.get("a")).toBeUndefined()
    expect(s.take("a")).toBeUndefined()
  })

  test("sustained insert load keeps only the last maxSize entries", () => {
    const s = new OutcomeStore<number, number>(5)
    for (let i = 0; i < 1000; i++) s.put(i, i)
    expect(s.size).toBe(5)
    for (let i = 995; i < 1000; i++) {
      expect(s.get(i)).toBe(i)
    }
    expect(s.get(994)).toBeUndefined()
    expect(s.get(0)).toBeUndefined()
  })
})

describe("OutcomeStore — validation", () => {
  test("rejects negative or non-integer capacity", () => {
    expect(() => new OutcomeStore<string, number>(-1)).toThrow(/non-negative integer/)
    expect(() => new OutcomeStore<string, number>(1.5)).toThrow(/non-negative integer/)
    expect(() => new OutcomeStore<string, number>(Number.NaN)).toThrow(/non-negative integer/)
  })
})

describe("OutcomeStore — clear", () => {
  test("clear drops all entries", () => {
    const s = new OutcomeStore<string, number>(5)
    s.put("a", 1)
    s.put("b", 2)
    expect(s.size).toBe(2)
    s.clear()
    expect(s.size).toBe(0)
    expect(s.get("a")).toBeUndefined()
    expect(s.get("b")).toBeUndefined()
  })
})
