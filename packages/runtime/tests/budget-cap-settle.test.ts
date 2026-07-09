// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Tests for Bug #2 — token-cap branch in executeAgentCall did not settle
// the run. Pre-fix: workflow:finished fired, counters decremented, but
// entry.status stayed "running", this.runs still held the entry,
// entry.outcomePromise never resolved (wait() hung), and subsequent
// agents kept executing. Post-fix: failRun is called, which transitions
// the run to "budget_exceeded", drops the entry from this.runs, resolves
// the outcome, and persists the new status to the DB.

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-budget-cap-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import { WorkflowPersistence } from "../src/persistence.ts"

// Mock LLM that reports 150 input + 50 output tokens per call → 200
// total. With maxTokens=200 set in tests, the FIRST call already exceeds
// the cap; with maxTokens=250, the SECOND call does.
const MOCK_LLM_TOKENS = { input: 150, output: 50 } // total = 200

const mockCtx: PluginContext = {
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: MOCK_LLM_TOKENS },
        content: [{ type: "text", text: "ok" }],
        finalText: "ok",
      }),
    },
  },
}

const p = new WorkflowPersistence({ dataDir: tmpDir })

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Settlement behavior ────────────────────────────────────────────────────

describe("Token cap run settlement", () => {
  test("run with maxTokens=200 settles with status 'budget_exceeded' after first agent", async () => {
    // maxTokens=200 + 200 tokens per agent → first call triggers cap.
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 200, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-first", description: "t", phases: [] }
        async function main() {
          await agent("first task"); // exceeds cap on first call
          return "unexpected";
        }`,
      workspace: tmpDir,
    })

    // wait() must return — not hang — with budget_exceeded.
    const outcome = await runtime.wait({ runID, timeoutMs: 5_000 })
    expect(outcome.status).toBe("budget_exceeded")
    expect(outcome.error).toMatch(/budget exceeded/i)
  })

  test("run with maxTokens=250 settles after second agent (together exceed)", async () => {
    // 250 max, 200/agent → first OK (200<250), second pushes to 400 → cap.
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 250, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-second", description: "t", phases: [] }
        async function main() {
          const r1 = await agent("first task");
          const r2 = await agent("second task"); // triggers cap
          return "should-not-reach";
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 5_000 })
    expect(outcome.status).toBe("budget_exceeded")
    // One successful (r1), one failed (r2). stepIndex matches succeeded+failed.
    expect(outcome.stepsCompleted).toBe(2)
  })

  test("DB row reflects 'budget_exceeded' status", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 200, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-db-status", description: "t", phases: [] }
        async function main() { await agent("x"); return "x"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5_000 })

    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.status).toBe("budget_exceeded")
    expect(row!.error).toMatch(/budget exceeded/i)
  })

  test("settled run is removed from this.runs (no leak)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 200, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-leak-check", description: "t", phases: [] }
        async function main() { await agent("x"); return "x"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5_000 })

    // Reflection: settled entries MUST NOT remain in this.runs.
    const internalRuns = (
      runtime as unknown as { runs: Map<string, unknown> }
    ).runs
    expect(internalRuns.has(runID)).toBe(false)
  })

  test("workflow:finished event fires with status='budget_exceeded'", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 200, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })

    const finishedEvents: Array<{ runID: string; status: string }> = []
    runtime.events.on("workflow:finished", (e: { runID: string; status: string }) => {
      finishedEvents.push(e)
    })

    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-event", description: "t", phases: [] }
        async function main() { await agent("x"); return "x"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5_000 })

    // Find the budget_exceeded event for our runID. May be 1 event total —
    // pre-fix double-fire (one from the buggy branch, one from failRun) is
    // gone because the buggy emit was removed.
    const matching = finishedEvents.filter((e) => e.runID === runID)
    expect(matching.length).toBe(1)
    expect(matching[0].status).toBe("budget_exceeded")
  })

  test("late wait() after budget_exceeded returns the cached outcome", async () => {
    // Pre-fix the late wait() hung forever because outcomePromise was never
    // resolved. Post-fix, the LRU caches the settled outcome so the late
    // call still gets the budget_exceeded shape (matches the C-2 design).
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    runtime.setConfig({
      maxSteps: 50, maxTokens: 200, maxWallClockMs: 60_000, perStepTimeoutMs: 5_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cap-late-wait", description: "t", phases: [] }
        async function main() { await agent("x"); return "x"; }`,
      workspace: tmpDir,
    })
    const outcome1 = await runtime.wait({ runID, timeoutMs: 5_000 })
    expect(outcome1.status).toBe("budget_exceeded")

    // Second call after settle — must not hang, must return same status.
    const outcome2 = await runtime.wait({ runID, timeoutMs: 1_000 })
    expect(outcome2.status).toBe("budget_exceeded")
  })
})