// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect, beforeEach } from "bun:test"
import { AgentPrimitive } from "../src/agent-primitive.ts"
import { journalKeyBase } from "../src/persistence.ts"
import type { InternalRunEntry, AgentResult } from "../src/internal-run-entry.ts"
import type { AgentOptions, AgentFailureReason } from "../src/types.ts"
import { BudgetExceededError } from "../src/types.ts"

// Fake counter state — the real CounterManager has many methods; we mock
// just what the agent-primitive methods actually call.
function makeFakeCounters() {
  return {
    tokensUsed: 0,
    succeeded: 0,
    failed: 0,
    agentCountTotal: 0,
    addTokens: (input: number, output: number) => { fakeCounters.tokensUsed += input + output },
    recordJournalHit: () => {},
    recordAgentStart: () => { fakeCounters.agentCountTotal++ },
    recordAgentSucceed: () => { fakeCounters.succeeded++ },
    recordAgentFail: () => { fakeCounters.failed++ },
  }
}
const fakeCounters = makeFakeCounters() as any

// Fake entry — minimal surface that spawnAgent/executeAgentCall need.
function makeEntry(overrides: Partial<InternalRunEntry> = {}): InternalRunEntry {
  return {
    runID: "run_test",
    journalResults: new Map(),
    journalPass: 0,
    capWarned: false,
    controller: { signal: { aborted: false } },
    cfg: { maxSteps: 100, maxTokens: 10000, maxWallClockMs: 60000, perStepTimeoutMs: 1000, gracePeriodMs: 5000, maxDepth: 3, maxLifecycleAgents: 10 },
    counters: fakeCounters,
    ...overrides,
  } as unknown as InternalRunEntry
}

// Fake deps — capture calls so the assertions can inspect side-effects.
function makeDeps(overrides: Partial<ConstructorParameters<typeof AgentPrimitive>[0]> = {}) {
  const calls: Array<{ name: string; payload?: unknown }> = []
  const failCalls: Array<{ runID: string; agentKey: string; reason: AgentFailureReason }> = []
  const flushes: InternalRunEntry[] = []
  const journalAppends: Array<{ runID: string; entry: unknown }> = []
  const failedRuns: Array<{ entry: InternalRunEntry; error: string }> = []

  let llmResult: any = { content: [{ type: "text", text: "ok" }], finalText: "ok" }
  let llmShouldThrow = false

  return {
    deps: {
      globalSem: { run: async <T,>(fn: () => Promise<T>): Promise<T> => fn() },
      scheduleFlush: (entry: InternalRunEntry) => flushes.push(entry),
      emitEvent: (name: string, payload?: unknown) => calls.push({ name, payload }),
      callLLM: async (_entry: InternalRunEntry, _prompt: string, _opts: AgentOptions) => {
        if (llmShouldThrow) throw new Error("LLM failed")
        return llmResult
      },
      appendJournal: (runID: string, e: unknown) => journalAppends.push({ runID, entry: e }),
      failRun: (entry: InternalRunEntry, error: string | Error) => failedRuns.push({ entry, error }),
      ...overrides,
    } as ConstructorParameters<typeof AgentPrimitive>[0],
    calls,
    failCalls,
    flushes,
    journalAppends,
    failedRuns,
    setLLMResult: (r: any) => { llmResult = r },
    setLLMShouldThrow: (v: boolean) => { llmShouldThrow = v },
  }
}

describe("AgentPrimitive", () => {
  let f: ReturnType<typeof makeDeps>
  let primitive: AgentPrimitive

  beforeEach(() => {
    fakeCounters.tokensUsed = 0
    fakeCounters.succeeded = 0
    fakeCounters.failed = 0
    fakeCounters.agentCountTotal = 0
    f = makeDeps()
    primitive = new AgentPrimitive(f.deps)
  })

  // ── spawnAgent ───────────────────────────────────────────────────────

  describe("spawnAgent", () => {
    it("hits the journal cache when the key is pre-populated", async () => {
      const entry = makeEntry()
      // Compute the actual key that spawnAgent will use
      const base = journalKeyBase("test prompt", {
        agentType: undefined,
        model: undefined,
        schema: undefined,
        phase: undefined,
      })
      const cacheKey = base + ":0"
      entry.journalResults.set(cacheKey, "cached-result")
      const occ = new Map<string, number>()
      const r = await primitive.spawnAgent(entry, "test prompt", undefined, occ)
      // Cache hit: no LLM call, no journal append, returns cached value
      expect(f.journalAppends).toHaveLength(0)
      expect(r).toBe("cached-result")
    })

    it("returns null when lifecycle cap is reached", async () => {
      fakeCounters.agentCountTotal = 10
      const entry = makeEntry()
      const occ = new Map<string, number>()
      const r = await primitive.spawnAgent(entry, "test", undefined, occ)
      expect(r).toBeNull()
    })

    it("returns null when token cap is already reached", async () => {
      fakeCounters.tokensUsed = 10000
      const entry = makeEntry()
      const occ = new Map<string, number>()
      const r = await primitive.spawnAgent(entry, "test", undefined, occ)
      expect(r).toBeNull()
    })

    it("returns null when maxSteps is already reached", async () => {
      fakeCounters.succeeded = 100
      const entry = makeEntry()
      const occ = new Map<string, number>()
      const r = await primitive.spawnAgent(entry, "test", undefined, occ)
      expect(r).toBeNull()
    })

    it("returns null when controller is already aborted", async () => {
      const entry = makeEntry({ controller: { signal: { aborted: true } } })
      const occ = new Map<string, number>()
      const r = await primitive.spawnAgent(entry, "test", undefined, occ)
      expect(r).toBeNull()
    })

    it("throws when depth exceeds maxDepth", async () => {
      const entry = makeEntry()
      const occ = new Map<string, number>()
      await expect(primitive.spawnAgent(entry, "test", { depth: 5 } as AgentOptions, occ)).rejects.toThrow(/nesting depth/)
    })

    it("records counter invariants (agentCountTotal++)", async () => {
      const entry = makeEntry()
      const occ = new Map<string, number>()
      await primitive.spawnAgent(entry, "test", undefined, occ)
      expect(fakeCounters.agentCountTotal).toBe(1)
    })
  })

  // ── executeAgentCall ─────────────────────────────────────────────────

  describe("executeAgentCall", () => {
    it("returns null and calls failRun when token cap is hit post-LLM", async () => {
      f.setLLMResult({
        content: [{ type: "text", text: "ok" }],
        finalText: "ok",
        info: { tokens: { input: 6000, output: 4001 } },
      })
      const entry = makeEntry()
      const r = await primitive.executeAgentCall(entry, "test", {} as AgentOptions, "key1")
      expect(r).toBeNull()
      expect(f.failedRuns).toHaveLength(1)
      // gen-11 F-2.1: error is now a typed BudgetExceededError, not a magic string.
      expect(f.failedRuns[0]?.error).toBeInstanceOf(BudgetExceededError)
      expect((f.failedRuns[0]?.error as BudgetExceededError).message).toMatch(/budget/i)
    })

    it("returns null when deliverable is null (NoDeliverable)", async () => {
      f.setLLMResult({ content: [], structured: null, finalText: null })
      const entry = makeEntry()
      const r = await primitive.executeAgentCall(entry, "test", {} as AgentOptions, "key1")
      expect(r).toBeNull()
      expect(fakeCounters.failed).toBe(1)
    })

    it("returns structured result when schema is set", async () => {
      f.setLLMResult({ content: [], structured: { foo: 1 }, finalText: null })
      const entry = makeEntry()
      const r = await primitive.executeAgentCall(entry, "test", { schema: { type: "object" } } as AgentOptions, "key1")
      expect(r).toEqual({ foo: 1 })
    })

    it("appends to journal on success", async () => {
      const entry = makeEntry()
      await primitive.executeAgentCall(entry, "test", {} as AgentOptions, "key_abc")
      expect(f.journalAppends).toHaveLength(1)
      expect(f.journalAppends[0]?.entry).toMatchObject({ t: "agent", key: "key_abc" })
    })

    it("returns null on LLM throw (SpawnReject)", async () => {
      f.setLLMShouldThrow(true)
      const entry = makeEntry()
      const r = await primitive.executeAgentCall(entry, "test", {} as AgentOptions, "key1")
      expect(r).toBeNull()
      expect(fakeCounters.failed).toBe(1)
    })
  })

  // ── runParallel / runPipeline ────────────────────────────────────────

  describe("runParallel", () => {
    it("returns an array of results in order", async () => {
      const r = await primitive.runParallel([
        async () => 1,
        async () => 2,
        async () => 3,
      ])
      expect(r).toEqual([1, 2, 3])
    })

    it("propagates rejection if a thunk throws", async () => {
      await expect(primitive.runParallel([
        async () => 1,
        async () => { throw new Error("boom") },
      ])).rejects.toThrow("boom")
    })
  })

  describe("runPipeline", () => {
    it("threads items through stages sequentially", async () => {
      const r = await primitive.runPipeline(
        [1, 2, 3],
        [(acc: unknown) => Promise.resolve((acc as number) * 2)],
      )
      expect(r).toEqual([2, 4, 6])
    })

    it("passes (acc, item, i) to each stage", async () => {
      let captured: any = null
      await primitive.runPipeline(
        ["x"],
        [(acc, item, i) => { captured = { acc, item, i }; return Promise.resolve("done") }],
      )
      expect(captured).toEqual({ acc: "x", item: "x", i: 0 })
    })
  })

  // ── publishAgentFailed ───────────────────────────────────────────────

  describe("publishAgentFailed", () => {
    it("emits workflow:agent_failed with runID/agentKey/reason", () => {
      primitive.publishAgentFailed("run1", "key1", "actor_error" as AgentFailureReason)
      expect(f.calls).toContainEqual({
        name: "workflow:agent_failed",
        payload: { runID: "run1", agentKey: "key1", reason: "actor_error" },
      })
    })

    it("catches listener errors so the run is not broken", () => {
      // Override emitEvent to throw
      f.deps.emitEvent = () => { throw new Error("listener crashed") }
      const p2 = new AgentPrimitive(f.deps)
      // Should NOT throw — manually catch (instead of .not.toThrow()) to avoid
      // bun test runner hanging on synchronous-error stack trace in batch mode
      let didThrow = false
      try {
        p2.publishAgentFailed("r", "k", "spawn_reject" as AgentFailureReason)
      } catch {
        didThrow = true
      }
      expect(didThrow).toBe(false)
    })
  })
})
