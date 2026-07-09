// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect, beforeEach } from "bun:test"
import { RunCompleter } from "../src/run-completer.ts"
import type { InternalRunEntry } from "../src/internal-run-entry.ts"

// Minimal in-memory mocks for the 4 collaborators. Each is a plain object
// capturing calls so the assertions can inspect side-effects.

function makeFakePersistence() {
  return {
    updateRunStatus: (runID: string, status: string, error?: string) => {
      fakePersistence.updates.push({ runID, status, error })
    },
    flushJournalSync: () => {
      fakePersistence.flushes++
    },
  } as unknown as ConstructorParameters<typeof RunCompleter>[0]["persistence"]
}

const fakePersistence = { updates: [] as Array<{ runID: string; status: string; error?: string }>, flushes: 0 }

function makeFakeEvents() {
  const emitted: Array<{ name: string; payload: unknown }> = []
  return {
    emit: (name: string, payload: unknown) => {
      emitted.push({ name, payload })
    },
    _emitted: emitted,
  } as unknown as ConstructorParameters<typeof RunCompleter>[0]["events"] & { _emitted: typeof emitted }
}

function makeFakeOutcomes() {
  return {
    put: (runID: string, outcome: unknown) => {
      fakeOutcomes.puts.push({ runID, outcome })
    },
  } as unknown as ConstructorParameters<typeof RunCompleter>[0]["outcomes"]
}
const fakeOutcomes = { puts: [] as Array<{ runID: string; outcome: unknown }> }

function makeFakeRuns() {
  return {
    release: (runID: string) => {
      fakeRuns.released.push(runID)
    },
  } as unknown as ConstructorParameters<typeof RunCompleter>[0]["runs"]
}
const fakeRuns = { released: [] as string[] }

function makeEntry(overrides: Partial<InternalRunEntry> = {}): InternalRunEntry & { resolveOutcome: ReturnType<typeof mock>; _resolved: unknown[] } {
  const entry: any = {
    runID: "run_test",
    status: "running",
    cfg: { maxTokens: 1000, maxSteps: 10, maxWallClockMs: 10000, perStepTimeoutMs: 1000, gracePeriodMs: 5000, maxDepth: 5, maxLifecycleAgents: 5 },
    startedMs: Date.now(),
    counters: { succeeded: 0, failed: 0, tokensUsed: 0 },
    resolveOutcome: (outcome: unknown) => { entry._resolved.push(outcome) },
    _resolved: [],
    ...overrides,
  }
  return entry
}

describe("RunCompleter", () => {
  let completer: RunCompleter
  let events: ReturnType<typeof makeFakeEvents>

  beforeEach(() => {
    fakePersistence.updates.length = 0
    fakePersistence.flushes = 0
    fakeOutcomes.puts.length = 0
    fakeRuns.released.length = 0
    events = makeFakeEvents()
    completer = new RunCompleter({
      persistence: makeFakePersistence(),
      events,
      outcomes: makeFakeOutcomes(),
      runs: makeFakeRuns(),
      launchScript: (async () => "ok") as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
    })
  })

  // ── completeRun ──────────────────────────────────────────────────────

  describe("completeRun", () => {
    it("transitions running → completed and persists", () => {
      const entry = makeEntry()
      completer.completeRun(entry, { foo: 1 })
      expect(entry.status).toBe("completed")
      expect(fakePersistence.updates).toEqual([{ runID: "run_test", status: "completed", error: undefined }])
      expect(fakePersistence.flushes).toBe(1)
    })

    it("emits workflow:finished with status=completed", () => {
      const entry = makeEntry()
      completer.completeRun(entry, "ok")
      expect(events._emitted).toHaveLength(1)
      expect(events._emitted[0]?.name).toBe("workflow:finished")
      expect(events._emitted[0]?.payload).toEqual({ runID: "run_test", status: "completed" })
    })

    it("caches the outcome and releases the run", () => {
      const entry = makeEntry()
      completer.completeRun(entry, "result")
      expect(fakeOutcomes.puts).toHaveLength(1)
      expect(fakeOutcomes.puts[0]?.runID).toBe("run_test")
      expect(fakeRuns.released).toEqual(["run_test"])
    })

    it("resolves the outcome via entry.resolveOutcome", () => {
      const entry = makeEntry()
      completer.completeRun(entry, "data")
      expect(entry._resolved).toHaveLength(1)
    })

    it("is a no-op when status !== running (guard against race)", () => {
      const entry = makeEntry({ status: "cancelled" })
      completer.completeRun(entry, "x")
      expect(entry.status).toBe("cancelled")
      expect(fakePersistence.updates).toHaveLength(0)
    })
  })

  // ── failRun ──────────────────────────────────────────────────────────

  describe("failRun", () => {
    it("transitions running → failed by default", () => {
      const entry = makeEntry()
      completer.failRun(entry, "boom")
      expect(entry.status).toBe("failed")
      expect(fakePersistence.updates[0]?.error).toBe("boom")
    })

    it('classifies "budget_exceeded" when error message contains "budget_exceeded"', () => {
      const entry = makeEntry()
      completer.failRun(entry, "Token budget_exceeded: cap 1000 exceeded")
      expect(entry.status).toBe("budget_exceeded")
      expect(events._emitted[0]?.payload).toEqual({ runID: "run_test", status: "budget_exceeded", error: "Token budget_exceeded: cap 1000 exceeded" })
    })

    it('classifies "budget_exceeded" when error message contains "deadline exceeded"', () => {
      const entry = makeEntry()
      completer.failRun(entry, "deadline exceeded")
      expect(entry.status).toBe("budget_exceeded")
    })

    it("is a no-op when status !== running", () => {
      const entry = makeEntry({ status: "completed" })
      completer.failRun(entry, "ignored")
      expect(entry.status).toBe("completed")
    })

    it("caches the outcome and releases the run", () => {
      const entry = makeEntry()
      completer.failRun(entry, "boom")
      expect(fakeOutcomes.puts).toHaveLength(1)
      expect(fakeRuns.released).toEqual(["run_test"])
    })
  })

  // ── settleEntry ──────────────────────────────────────────────────────

  describe("settleEntry", () => {
    it("routes a non-null result to completeRun", async () => {
      const entry = makeEntry()
      const completerWithLaunch = new RunCompleter({
        persistence: makeFakePersistence(),
        events: makeFakeEvents(),
        outcomes: makeFakeOutcomes(),
        runs: makeFakeRuns(),
        launchScript: (async () => "result-ok") as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
      })
      await completerWithLaunch.settleEntry(entry, "script", "name", [], "jail")
      expect(entry.status).toBe("completed")
    })

    it("routes a null result to failRun with 'Sandbox execution failed'", async () => {
      const entry = makeEntry()
      const completerWithLaunch = new RunCompleter({
        persistence: makeFakePersistence(),
        events: makeFakeEvents(),
        outcomes: makeFakeOutcomes(),
        runs: makeFakeRuns(),
        launchScript: (async () => null) as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
      })
      await completerWithLaunch.settleEntry(entry, "script", "name", [], "jail")
      expect(entry.status).toBe("failed")
      expect(fakePersistence.updates[0]?.error).toBe("Sandbox execution failed")
    })

    it("routes a thrown error to failRun with the error message", async () => {
      const entry = makeEntry()
      const completerWithLaunch = new RunCompleter({
        persistence: makeFakePersistence(),
        events: makeFakeEvents(),
        outcomes: makeFakeOutcomes(),
        runs: makeFakeRuns(),
        launchScript: (async () => { throw new Error("kaboom") }) as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
      })
      await completerWithLaunch.settleEntry(entry, "script", "name", [], "jail")
      expect(entry.status).toBe("failed")
      expect(fakePersistence.updates[0]?.error).toBe("kaboom")
    })

    it("coerces non-Error throws to a string", async () => {
      const entry = makeEntry()
      const completerWithLaunch = new RunCompleter({
        persistence: makeFakePersistence(),
        events: makeFakeEvents(),
        outcomes: makeFakeOutcomes(),
        runs: makeFakeRuns(),
        launchScript: (async () => { throw "string-throw" }) as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
      })
      await completerWithLaunch.settleEntry(entry, "script", "name", [], "jail")
      expect(fakePersistence.updates[0]?.error).toBe("string-throw")
    })

    it("does not propagate throws from launchScript", async () => {
      const entry = makeEntry()
      const completerWithLaunch = new RunCompleter({
        persistence: makeFakePersistence(),
        events: makeFakeEvents(),
        outcomes: makeFakeOutcomes(),
        runs: makeFakeRuns(),
        launchScript: (async () => { throw new Error("explode") }) as ConstructorParameters<typeof RunCompleter>[0]["launchScript"],
      })
      // settleEntry itself should resolve, not throw
      await expect(completerWithLaunch.settleEntry(entry, "script", "name", [], "jail")).resolves.toBeUndefined()
    })
  })
})
