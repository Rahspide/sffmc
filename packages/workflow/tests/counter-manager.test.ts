// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// TDD interface tests for CounterManager — extracted from WorkflowRuntime
// (M-1 god-object refactor, Task 1.2).
//
// The brief's sketched interface (inputTokens / outputTokens / costCents)
// didn't match the actual runtime.ts shape. The real per-run counters on
// InternalRunEntry are: running, succeeded, failed, agentCount,
// agentCountTotal, tokensUsed. These tests pin the real semantics so the
// refactor from inline `entry.running++` / `entry.tokensUsed += total`
// patterns to `entry.counters.recordXxx()` calls doesn't drift.

import { describe, test, expect } from "bun:test"
import { CounterManager } from "../src/counter-manager.ts"

describe("CounterManager — initial state", () => {
  test("starts with all counters at zero", () => {
    const cm = new CounterManager()
    expect(cm.snapshot()).toEqual({
      running: 0,
      succeeded: 0,
      failed: 0,
      agentCount: 0,
      agentCountTotal: 0,
      tokensUsed: 0,
    })
  })
})

describe("CounterManager — recordAgentStart()", () => {
  test("bumps running + agentCount + agentCountTotal by 1 each", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    expect(cm.snapshot()).toEqual({
      running: 1,
      succeeded: 0,
      failed: 0,
      agentCount: 1,
      agentCountTotal: 1,
      tokensUsed: 0,
    })
  })

  test("concurrent agents stack correctly in 'running' and accumulate in 'agentCountTotal'", () => {
    const cm = new CounterManager()
    cm.recordAgentStart() // agent #1 in flight
    cm.recordAgentStart() // agent #2 in flight (concurrent)
    expect(cm.running).toBe(2)
    expect(cm.agentCount).toBe(2) // unique count this lifecycle
    expect(cm.agentCountTotal).toBe(2) // lifetime count (no cap yet)
  })
})

describe("CounterManager — recordAgentSucceed() / recordAgentFail()", () => {
  test("succeed decrements running, increments succeeded", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.recordAgentSucceed()
    expect(cm.running).toBe(0)
    expect(cm.succeeded).toBe(1)
    expect(cm.failed).toBe(0)
  })

  test("fail decrements running, increments failed", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.recordAgentFail()
    expect(cm.running).toBe(0)
    expect(cm.succeeded).toBe(0)
    expect(cm.failed).toBe(1)
  })

  test("mixed lifecycle: start/succeed/start/fail reaches balanced state", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.recordAgentSucceed()
    cm.recordAgentStart()
    cm.recordAgentFail()
    expect(cm.snapshot()).toEqual({
      running: 0,
      succeeded: 1,
      failed: 1,
      agentCount: 2,
      agentCountTotal: 2,
      tokensUsed: 0,
    })
  })
})

describe("CounterManager — recordJournalHit()", () => {
  test("journal hit increments succeeded WITHOUT touching running (cached result, agent never started)", () => {
    const cm = new CounterManager()
    cm.recordJournalHit()
    cm.recordJournalHit()
    expect(cm.snapshot()).toEqual({
      running: 0,
      succeeded: 2,
      failed: 0,
      agentCount: 0,
      agentCountTotal: 0,
      tokensUsed: 0,
    })
  })
})

describe("CounterManager — addTokens()", () => {
  test("aggregates input + output into tokensUsed", () => {
    const cm = new CounterManager()
    cm.addTokens(100, 50)
    cm.addTokens(200, 100)
    expect(cm.tokensUsed).toBe(450)
  })

  test("treats undefined input or output as zero", () => {
    const cm = new CounterManager()
    // Real runtime.ts:812 calls `addTokens(tokens?.input ?? 0, tokens?.output ?? 0)`,
    // but the CounterManager should also tolerate being called with raw undefined
    // values to mirror that null-safety in case callers forget.
    cm.addTokens(undefined as unknown as number, undefined as unknown as number)
    expect(cm.tokensUsed).toBe(0)
  })

  test("zero-token calls don't disturb other counters", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.addTokens(0, 0)
    expect(cm.tokensUsed).toBe(0)
    expect(cm.running).toBe(1)
  })
})

describe("CounterManager — reset()", () => {
  test("clears all counters back to zero", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.recordAgentStart()
    cm.recordAgentSucceed()
    cm.recordAgentFail()
    cm.addTokens(500, 250)
    cm.recordJournalHit()
    // Sanity: not zero before reset
    expect(cm.snapshot()).not.toEqual({
      running: 0, succeeded: 0, failed: 0,
      agentCount: 0, agentCountTotal: 0, tokensUsed: 0,
    })
    cm.reset()
    expect(cm.snapshot()).toEqual({
      running: 0,
      succeeded: 0,
      failed: 0,
      agentCount: 0,
      agentCountTotal: 0,
      tokensUsed: 0,
    })
  })

  test("reset is idempotent", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    cm.reset()
    cm.reset()
    expect(cm.tokensUsed).toBe(0)
  })
})

describe("CounterManager — snapshot()", () => {
  test("returns a fresh object (mutating the snapshot doesn't affect internal state)", () => {
    const cm = new CounterManager()
    cm.recordAgentStart()
    const snap1 = cm.snapshot()
    snap1.running = 999
    snap1.tokensUsed = 999
    // internal state untouched
    const snap2 = cm.snapshot()
    expect(snap2.running).toBe(1)
    expect(snap2.tokensUsed).toBe(0)
  })
})

describe("CounterManager — large numbers / accumulated workload", () => {
  test("handles thousands of agent starts + completes without precision loss", () => {
    const cm = new CounterManager()
    const N = 5_000
    for (let i = 0; i < N; i++) {
      cm.recordAgentStart()
      cm.recordAgentSucceed()
    }
    expect(cm.running).toBe(0)
    expect(cm.succeeded).toBe(N)
    expect(cm.agentCountTotal).toBe(N)
  })

  test("aggregates millions of tokens", () => {
    const cm = new CounterManager()
    cm.addTokens(1_000_000, 500_000)
    cm.addTokens(2_000_000, 1_000_000)
    expect(cm.tokensUsed).toBe(4_500_000)
  })
})