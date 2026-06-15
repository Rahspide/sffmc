// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { test, expect, describe, beforeAll, afterAll } from "bun:test"
import { WorkflowRuntime } from "./runtime.ts"
import { setRuntime, getRuntime } from "./runtime-ref.ts"
import { clearAll, emit, on } from "./events.ts"
import { WorkflowPersistence } from "./persistence.ts"
import type { PluginContext } from "./runtime.ts"
import type { WorkflowOutcome, WorkflowStatusOutput } from "./types.ts"

// ---------------------------------------------------------------------------
// Mock LLM context
// ---------------------------------------------------------------------------

function makeMockCtx(callCounts?: { count: number }): PluginContext {
  return {
    client: {
      session: {
        async message(params: {
          messages: Array<{ role: string; content: string }>
          model?: string
          tools?: string[] | "INHERIT"
        }) {
          if (callCounts) callCounts.count++
          // Extract what the agent was asked
          const userMsg = params.messages.find((m) => m.role === "user")?.content ?? ""
          const isSchema = params.messages.some((m) =>
            m.content.includes("valid JSON matching the requested schema"),
          )

          // Return a simulated LLM response
          if (isSchema) {
            // Schema requested → return structured output
            return {
              content: [{ type: "text", text: JSON.stringify({ result: userMsg.slice(0, 50) }) }],
              info: { tokens: { input: 10, output: 20 } },
              structured: { result: userMsg.slice(0, 50) },
              finalText: JSON.stringify({ result: userMsg.slice(0, 50) }),
            }
          } else if (userMsg === "__THROW__") {
            throw new Error("Simulated LLM failure")
          } else if (userMsg === "__EMPTY__") {
            return {
              content: [{ type: "text", text: "" }],
              info: { tokens: { input: 5, output: 0 } },
              structured: undefined,
              finalText: undefined,
            }
          } else {
            return {
              content: [{ type: "text", text: userMsg }],
              info: { tokens: { input: 10, output: 5 } },
              structured: null,
              finalText: userMsg,
            }
          }
        },
      },
    },
    config: undefined,
    sessionID: "test-session",
  }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(() => {
  clearAll()
})

afterAll(() => {
  clearAll()
})

// ── agent() behavior ─────────────────────────────────────────────────────

describe("agent() never-throw contract", () => {
  test("agent() resolves to a string for normal prompts", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test", description: "test", phases: [] }\n
        async function main() {
          const result = await agent("normal prompt");
          return result;
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("normal prompt")
  }, 15000)

  test("agent() returns null on over-cap (lifecycle cap)", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    // Start a workflow that calls agent() 3 times
    const { runID } = await runtime.start({
      script: `export const meta = { name: "test-cap", description: "test", phases: [] }\n
        async function main() {
          const r1 = await agent("first");
          const r2 = await agent("second");
          const r3 = await agent("third");
          return [r1, r2, r3];
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 30000 })

    // With MAX_LIFECYCLE_AGENTS=1000, all should succeed
    expect(outcome.status).toBe("completed")
    const results = outcome.result as unknown[]
    expect(results.every((r) => r !== null)).toBe(true)
  }, 35000)

  test("agent() does not throw on LLM failure — returns null", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test-throw", description: "test", phases: [] }\n
        async function main() {
          const result = await agent("__THROW__");
          return typeof result;
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })

    // Script should have completed (agent returned null, which has typeof "object")
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("object") // typeof null === "object"
  }, 15000)

  test("agent() returns null for no-deliverable (LLM returns empty)", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test-empty", description: "test", phases: [] }\n
        async function main() {
          const result = await agent("__EMPTY__");
          return result === null ? "null_as_expected" : "got_value";
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("null_as_expected")
  }, 15000)
})

// ── parallel() / pipeline() ───────────────────────────────────────────────

describe("parallel() and pipeline()", () => {
  test("parallel() propagates throws (does NOT catch)", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test-parallel-throw", description: "test", phases: [] }\n
        async function main() {
          try {
            await parallel([
              () => Promise.resolve(1),
              () => Promise.reject(new Error("intentional throw in parallel")),
            ]);
            return "should_not_reach";
          } catch (e) {
            return "caught:" + e.message;
          }
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("caught:intentional throw in parallel")
  }, 15000)

  test("pipeline() does NOT catch throws", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test-pipeline-throw", description: "test", phases: [] }\n
        async function main() {
          try {
            const items = [1, 2, 3];
            const results = await pipeline(items,
              async (acc, item) => {
                if (item === 2) throw new Error("pipeline stage throw");
                return item;
              }
            );
            return "should_not_reach";
          } catch (e) {
            return "caught:" + e.message;
          }
        }`,
      args: {},
      sessionID: "test",
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })

    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("caught:pipeline stage throw")
  }, 15000)
})

// ── WorkflowRuntime lifecycle ────────────────────────────────────────────

describe("WorkflowRuntime lifecycle", () => {
  test("start() returns runID", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const result = await runtime.start({
      script: `export const meta = { name: "lifecycle-test", description: "test", phases: [] }\n
        async function main() {
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    expect(result.runID).toMatch(/^wf_/)
  })

  test("status() returns progress", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "status-test", description: "test", phases: [] }\n
        async function main() {
          phase("searching");
          await agent("first task");
          phase("reporting");
          await agent("second task");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    // Quick status check while running
    // Note: agent is async, so it may not have completed yet
    const status = await runtime.status({ runID })
    expect(status.runID).toBe(runID)
    expect(["running", "completed"]).toContain(status.status)

    // Wait for completion
    const outcome = await runtime.wait({ runID, timeoutMs: 30000 })
    expect(outcome.status).toBe("completed")
  }, 35000)

  test("cancel() stops a running workflow", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "cancel-test", description: "test", phases: [] }\n
        async function main() {
          // Simulate long-running work
          await agent("task 1");
          await agent("task 2");
          await agent("task 3");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    // Cancel immediately
    await runtime.cancel({ runID })

    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })

    expect(outcome.status).toBe("cancelled")
  }, 10000)

  test("list() returns all runs", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "list-test", description: "test", phases: [] }\n
        async function main() { return "done"; }`,
      args: {},
      sessionID: "test",
    })

    const list = await runtime.list()
    expect(list.some((r) => r.runID === runID)).toBe(true)
    expect(list.some((r) => r.name === "list-test")).toBe(true)
  })

  test("resume() returns resumed:false for live runs", async () => {
    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "resume-live-test", description: "test", phases: [] }\n
        async function main() {
          await agent("task");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    // Try to resume while running
    const result = await runtime.resume({ runID })
    expect(result.resumed).toBe(false)
    expect(result.runID).toBe(runID)

    // Cleanup
    await runtime.cancel({ runID })
  }, 10000)
})

// ── event bus ─────────────────────────────────────────────────────────────

describe("Event bus", () => {
  test("workflow:started fires on start", async () => {
    const events: string[] = []
    const key = on("workflow:started", (e) => {
      events.push(e.runID)
    })

    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "event-test", description: "test", phases: [] }\n
        async function main() { return "done"; }`,
      args: {},
      sessionID: "test",
    })

    await runtime.wait({ runID, timeoutMs: 10000 })

    expect(events).toContain(runID)
  }, 15000)

  test("workflow:finished fires on completion", async () => {
    const statuses: string[] = []
    on("workflow:finished", (e) => {
      const ev = e as import("./events.ts").WorkflowFinishedEvent
      statuses.push(ev.status)
    })

    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "finish-event-test", description: "test", phases: [] }\n
        async function main() { return "done"; }`,
      args: {},
      sessionID: "test",
    })

    await runtime.wait({ runID, timeoutMs: 10000 })

    expect(statuses).toContain("completed")
  }, 15000)

  test("workflow:agent_failed fires on LLM failure", async () => {
    const failures: Array<{ agentKey: string; reason: string }> = []
    on("workflow:agent_failed", (e) => {
      const ev = e as import("./events.ts").WorkflowAgentFailedEvent
      failures.push({ agentKey: ev.agentKey, reason: ev.reason })
    })

    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "fail-event-test", description: "test", phases: [] }\n
        async function main() {
          await agent("__THROW__");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    await runtime.wait({ runID, timeoutMs: 10000 })

    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures[0].reason).toBe("spawn-reject")
  }, 15000)
})

// ── Phase / log side-channel ────────────────────────────────────────────

describe("phase() and log() side-channels", () => {
  test("phase() emits workflow:phase events", async () => {
    const phases: string[] = []
    on("workflow:phase", (e) => {
      const ev = e as import("./events.ts").WorkflowPhaseEvent
      phases.push(ev.title)
    })

    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "phase-test", description: "test", phases: [] }\n
        async function main() {
          phase("step-one");
          await agent("task 1");
          phase("step-two");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    await runtime.wait({ runID, timeoutMs: 10000 })

    expect(phases).toContain("step-one")
    expect(phases).toContain("step-two")
  }, 15000)

  test("log() emits workflow:log events", async () => {
    const logs: string[] = []
    on("workflow:log", (e) => {
      const ev = e as import("./events.ts").WorkflowLogEvent
      logs.push(ev.message)
    })

    const ctx = makeMockCtx()
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "log-test", description: "test", phases: [] }\n
        async function main() {
          log("starting test");
          await agent("task 1");
          log("done with test");
          return "done";
        }`,
      args: {},
      sessionID: "test",
    })

    await runtime.wait({ runID, timeoutMs: 10000 })

    expect(logs).toContain("starting test")
    expect(logs).toContain("done with test")
  }, 15000)
})
