// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Tests for the BoundedLRU class (packages/workflow/src/lru.ts) and its
// integration with WorkflowRuntime.completedOutcomes. Covers:
//   - direct BoundedLRU unit tests (insert / over-cap / oldest-evicted /
//     delete / clear / re-set semantics / size=0)
//   - WORKFLOW_OUTCOMES_CACHE_SIZE env var resolution
//   - RuntimeOpts.completedOutcomesCacheSize override
//   - late wait() for evicted runID → "unknown runID" (per design comment)

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-lru-"))
process.env.XDG_DATA_HOME = tmpDir

import { BoundedLRU } from "../src/lru.ts"
import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import { CounterManager } from "../src/counter-manager.ts"

const mockCtx: PluginContext = {
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: { input: 0, output: 0 } },
        content: [{ type: "text", text: "ok" }],
        finalText: "ok",
      }),
    },
  },
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── BoundedLRU unit tests ─────────────────────────────────────────────────

describe("BoundedLRU", () => {
  test("rejects negative / non-integer capacity", () => {
    expect(() => new BoundedLRU<string, number>(-1)).toThrow(/non-negative integer/)
    expect(() => new BoundedLRU<string, number>(1.5)).toThrow(/non-negative integer/)
    expect(() => new BoundedLRU<string, number>(Number.NaN)).toThrow(/non-negative integer/)
  })

  test("set + get + size", () => {
    const lru = new BoundedLRU<string, number>(3)
    expect(lru.size).toBe(0)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("c", 3)
    expect(lru.size).toBe(3)
    expect(lru.get("a")).toBe(1)
    expect(lru.get("missing")).toBeUndefined()
  })

  test("evicts oldest entries when over capacity", () => {
    const lru = new BoundedLRU<string, number>(3)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("c", 3)
    lru.set("d", 4) // evicts "a"
    expect(lru.size).toBe(3)
    expect(lru.get("a")).toBeUndefined()
    expect(lru.get("b")).toBe(2)
    expect(lru.get("c")).toBe(3)
    expect(lru.get("d")).toBe(4)
  })

  test("oldest is evicted first under sustained insert load", () => {
    const lru = new BoundedLRU<number, number>(5)
    for (let i = 0; i < 1000; i++) lru.set(i, i)
    expect(lru.size).toBe(5)
    // Only the last 5 inserted survive.
    expect(lru.get(995)).toBe(995)
    expect(lru.get(996)).toBe(996)
    expect(lru.get(997)).toBe(997)
    expect(lru.get(998)).toBe(998)
    expect(lru.get(999)).toBe(999)
    // Anything older was evicted.
    expect(lru.get(994)).toBeUndefined()
    expect(lru.get(0)).toBeUndefined()
  })

  test("delete + clear", () => {
    const lru = new BoundedLRU<string, number>(5)
    lru.set("a", 1)
    lru.set("b", 2)
    expect(lru.delete("a")).toBe(true)
    expect(lru.delete("missing")).toBe(false)
    expect(lru.size).toBe(1)
    lru.clear()
    expect(lru.size).toBe(0)
  })

  test("re-setting existing key moves it to most-recent position", () => {
    // Spec semantics: "Use insertion order (Map preserves it in JS). When
    // size > maxSize, delete oldest entry." With a re-set, the entry
    // should be considered "new" for eviction purposes — i.e. evicted
    // AFTER more-recently-inserted peers. This matches the existing
    // implementation that deletes-then-sets.
    const lru = new BoundedLRU<string, number>(3)
    lru.set("a", 1)
    lru.set("b", 2)
    lru.set("c", 3)
    // Re-set "a" — should now be MRU.
    lru.set("a", 11)
    lru.set("d", 4) // "b" is now oldest → evicted
    expect(lru.get("b")).toBeUndefined()
    expect(lru.get("a")).toBe(11)
    expect(lru.get("c")).toBe(3)
    expect(lru.get("d")).toBe(4)
  })

  test("size=0 accepts writes but discards them", () => {
    const lru = new BoundedLRU<string, number>(0)
    lru.set("a", 1)
    lru.set("b", 2)
    expect(lru.size).toBe(0)
    expect(lru.get("a")).toBeUndefined()
  })
})

// ── Runtime integration: BoundedLRU is wired to completedOutcomes ────────

describe("WorkflowRuntime.completedOutcomes uses BoundedLRU", () => {
  test("WORKFLOW_OUTCOMES_CACHE_SIZE env var controls capacity", () => {
    const prev = process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
    try {
      process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = "7"
      const runtime = new WorkflowRuntime(mockCtx)
      const outcomes = (runtime as unknown as {
        completedOutcomes: BoundedLRU<string, unknown>
      }).completedOutcomes
      expect(outcomes.capacity).toBe(7)
      expect(outcomes.size).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
      else process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = prev
    }
  })

  test("invalid env var falls back to default 500", () => {
    const prev = process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
    try {
      process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = "not-a-number"
      const runtime = new WorkflowRuntime(mockCtx)
      const outcomes = (runtime as unknown as {
        completedOutcomes: BoundedLRU<string, unknown>
      }).completedOutcomes
      expect(outcomes.capacity).toBe(500)
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
      else process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = prev
    }
  })

  test("RuntimeOpts.completedOutcomesCacheSize overrides env var", () => {
    const prev = process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
    try {
      process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = "7"
      const runtime = new WorkflowRuntime(mockCtx, { completedOutcomesCacheSize: 3 })
      const outcomes = (runtime as unknown as {
        completedOutcomes: BoundedLRU<string, unknown>
      }).completedOutcomes
      expect(outcomes.capacity).toBe(3)
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_OUTCOMES_CACHE_SIZE
      else process.env.WORKFLOW_OUTCOMES_CACHE_SIZE = prev
    }
  })

  test("late wait() for evicted runID returns 'unknown runID' (LRU eviction works)", async () => {
    // Build a runtime with a tiny cache so we can drive eviction.
    const runtime = new WorkflowRuntime(mockCtx, { completedOutcomesCacheSize: 2 })

    // Populate via reflection on completeRun (private method).
    const completeRun = (
      runtime as unknown as {
        completeRun: (e: unknown) => void
      }
    ).completeRun.bind(runtime)

    const p = (runtime as unknown as {
      persistence: { loadRun: (id: string) => { runID: string } | null }
    }).persistence

    function makeFakeEntry(runID: string): Record<string, unknown> {
      let resolveOutcome: (o: unknown) => void = () => {}
      const outcomePromise = new Promise<unknown>((r) => { resolveOutcome = r })
      return {
        runID,
        name: "fake",
        status: "running",
        // M-1 (Task 1.2): counter state moved into CounterManager.
        // The fake entry now mirrors makeEntry()'s shape with a fresh
        // all-zero CounterManager instance.
        counters: new CounterManager(),
        capWarned: false,
        childRunIDs: new Set<string>(),
        startedMs: Date.now(),
        deadlineMs: Date.now() + 3_600_000,
        outcomePromise,
        resolveOutcome,
        controller: new AbortController(),
        journalResults: new Map(),
        journalPass: 0,
        cfg: {
          maxSteps: 200,
          maxTokens: 2_000_000,
          maxWallClockMs: 3_600_000,
          perStepTimeoutMs: 120_000,
          maxDepth: 8,
          maxLifecycleAgents: 1000,
        },
      }
    }

    // Drive 4 completions into the cache (capacity 2) — first 2 should evict.
    const persisted = (await import("../src/persistence.ts")).WorkflowPersistence
    const localP = new persisted({ dataDir: tmpDir })
    const cs = (await import("../src/persistence.ts")).computeScriptSha

    const ids: string[] = []
    for (let i = 0; i < 4; i++) {
      const id = localP.createRun(`e${i}.ts`, `evict-${i}`, cs("evict"))
      ids.push(id)
      const entry = makeFakeEntry(id)
      completeRun(entry)
    }

    // Cache size capped at 2 — oldest two should have been evicted.
    const outcomes = (runtime as unknown as {
      completedOutcomes: BoundedLRU<string, unknown>
    }).completedOutcomes
    expect(outcomes.size).toBe(2)
    // ids[0] and ids[1] evicted; ids[2] and ids[3] remain.
    expect(outcomes.get(ids[0])).toBeUndefined()
    expect(outcomes.get(ids[1])).toBeUndefined()
    expect(outcomes.get(ids[2])).toBeDefined()
    expect(outcomes.get(ids[3])).toBeDefined()

    // Late wait() for an evicted runID returns the "unknown runID" shape
    // (per the design comment at runtime.ts:443-445).
    const evictedOutcome = await runtime.wait({ runID: ids[0] })
    expect(evictedOutcome.status).toBe("failed")
    expect(evictedOutcome.error).toContain(`unknown runID ${ids[0]}`)
  })
})