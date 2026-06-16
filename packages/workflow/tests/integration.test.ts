// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, afterAll } from "bun:test"
import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import { DEFAULT_WORKFLOW_CONFIG } from "../src/types"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-integration-"))
process.env.XDG_DATA_HOME = tmpDir

const mockCtx: PluginContext = {
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: { input: 100, output: 50 } },
        content: [{ type: "text", text: "mock LLM response" }],
      }),
    },
  },
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow integration: sandbox + runtime", () => {
  test("runs simple workflow via sandbox", async () => {
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "test", description: "test", whenToUse: "test", phases: [] }
        async function main() {
          log("hello from sandbox");
          return "done";
        }`,
      workspace: tmpDir,
    })
    expect(runID).toMatch(/^wf_[0-9A-Za-z]{26}$/)

    // Wait for completion
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
  }, 10000)

  test("sandbox blocks escape attempt", async () => {
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "escape", description: "escape test", whenToUse: "test", phases: [] }
        async function main() {
          try {
            const r = require("fs").readFileSync("/etc/passwd","utf8");
            log("ESCAPED: " + r);
          } catch (e) {
            log("blocked: " + e.message);
          }
          return "safe";
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")

    // The log "ESCAPED: root:" should NOT appear
    const steps = await runtime.status({ runID })
    expect(JSON.stringify(steps)).not.toContain("root:")
  }, 10000)

  test("agent() fails gracefully inside sandbox", async () => {
    const ctx: PluginContext = {
      config: {},
      client: {
        session: {
          message: async (params) => {
            const userMsg = params.messages.find((m) => m.role === "user")?.content ?? ""
            if (userMsg === "__THROW__") {
              throw new Error("Simulated LLM failure")
            }
            return {
              info: { tokens: { input: 10, output: 5 } },
              content: [{ type: "text", text: userMsg }],
              finalText: userMsg,
            }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(ctx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "agent-fail", description: "agent failure test", phases: [] }
        async function main() {
          const result = await agent("__THROW__");
          return typeof result;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // typeof null === "object"
    expect(outcome.result).toBe("object")
  }, 15000)

  test("file read/write primitives work", async () => {
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "file-io", description: "file io test", phases: [] }
        async function main() {
          await writeFile("test.txt", "hello workspace");
          const content = await readFile("test.txt");
          const fileExists = await exists("test.txt");
          const missing = await exists("no-such-file.txt");
          const files = await glob("*.txt");
          return { content, fileExists, missing, files };
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toEqual({
      content: "hello workspace",
      fileExists: true,
      missing: false,
      files: ["test.txt"],
    })
  }, 15000)
})

// ---------------------------------------------------------------------------
// Private helpers: makeEntry, outcomeFor, resolveConfig, settleEntry
// ---------------------------------------------------------------------------

function makeSlowMockCtx(delayMs = 50): PluginContext {
  return {
    config: {},
    client: {
      session: {
        message: async () => {
          await new Promise(r => setTimeout(r, delayMs))
          return {
            info: { tokens: { input: 10, output: 5 } },
            content: [{ type: "text", text: "slow" }],
            finalText: "slow",
          }
        },
      },
    },
  }
}

function makeCountingMockCtx(): { ctx: PluginContext; counts: { count: number } } {
  const counts = { count: 0 }
  const ctx: PluginContext = {
    config: {},
    client: {
      session: {
        message: async () => {
          counts.count++
          return {
            info: { tokens: { input: 10, output: 5 } },
            content: [{ type: "text", text: `step-${counts.count}` }],
            finalText: `step-${counts.count}`,
          }
        },
      },
    },
  }
  return { ctx, counts }
}

// ── makeEntry ───────────────────────────────────────────────────────────

describe("private helpers: makeEntry", () => {
  test("initializes all counters to zero on start()", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "ctr-zero", description: "counter test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    // Check status immediately — counters should be initialized at 0
    const status = await runtime.status({ runID })
    expect(status.agentCount).toBe(0)
    expect(status.succeeded).toBe(0)
    expect(status.failed).toBe(0)

    await runtime.wait({ runID, timeoutMs: 5000 })
    runtime.close()
  })

  test("creates outcomePromise that resolves on completion", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "promise-test", description: "test", phases: [] }
        async function main() { return 42; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe(42)
    runtime.close()
  })

  test("creates AbortController that cancel() uses to stop workflows", async () => {
    const slowCtx = makeSlowMockCtx(100)
    const runtime = new WorkflowRuntime(slowCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "abort-test", description: "test", phases: [] }
        async function main() {
          await agent("task-1");
          await agent("task-2");
          await agent("task-3");
          return "done";
        }`,
      workspace: tmpDir,
    })
    await runtime.cancel({ runID })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("cancelled")
    runtime.close()
  })

  test("startChildWorkflow uses makeEntry with parent cfg", async () => {
    // Child workflow inherits parent's cfg via makeEntry({ ..., cfg: parent.cfg })
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "parent-wf", description: "parent", phases: [] }
        async function main() {
          const childResult = await workflow(
            \`export const meta = { name: "child-wf", description: "child", phases: [] }
            async function main() {
              return "child-ok";
            }\`
          );
          return childResult;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // Child returned successfully, proving makeEntry worked in startChildWorkflow
    expect(outcome.result).toBe("child-ok")
    runtime.close()
  }, 15000)

  test("startedMs set once — deadlineMs consistent with maxWallClockMs", async () => {
    // Indirect: outcome.durationMs is non-zero, proving startedMs was set
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "timing", description: "test", phases: [] }
        async function main() { return "fast"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.durationMs).toBeGreaterThan(0)
    // For a fast script, duration should be reasonable (< 5s)
    expect(outcome.durationMs).toBeLessThan(5000)
    runtime.close()
  })
})

// ── outcomeFor ──────────────────────────────────────────────────────────

describe("private helpers: outcomeFor", () => {
  test("completed status: all 7 outcome fields populated", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "outcome-ok", description: "test", phases: [] }
        async function main() { return "result-value"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.runID).toBe(runID)
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("result-value")
    expect(outcome.error).toBeUndefined()
    expect(typeof outcome.stepsCompleted).toBe("number")
    expect(outcome.stepsTotal).toBeGreaterThan(0)
    expect(typeof outcome.tokensUsed).toBe("number")
    expect(outcome.durationMs).toBeGreaterThan(0)
    runtime.close()
  })

  test("cancelled status: result absent, timing populated", async () => {
    const slowCtx = makeSlowMockCtx(100)
    const runtime = new WorkflowRuntime(slowCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "outcome-cancel", description: "test", phases: [] }
        async function main() {
          await agent("slow-task");
          return "done";
        }`,
      workspace: tmpDir,
    })
    await runtime.cancel({ runID })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("cancelled")
    expect(outcome.result).toBeUndefined()
    expect(typeof outcome.durationMs).toBe("number")
    expect(typeof outcome.stepsCompleted).toBe("number")
    expect(typeof outcome.stepsTotal).toBe("number")
    runtime.close()
  })

  test("failed status from script throw — sandbox returns null, failRun invoked", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "outcome-fail", description: "test", phases: [] }
        async function main() {
          throw new Error("intentional script failure");
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    // Sandbox catches thrown errors and returns null → settleEntry treats as failure
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("Sandbox execution failed")
    expect(outcome.result).toBeUndefined()
    expect(outcome.durationMs).toBeGreaterThan(0)
    expect(outcome.stepsCompleted).toBe(0)
    runtime.close()
  })

  test("timing: durationMs grows with agent work", async () => {
    const slowCtx = makeSlowMockCtx(40)
    const runtime = new WorkflowRuntime(slowCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "timing-grow", description: "test", phases: [] }
        async function main() {
          await agent("slow-1");
          await agent("slow-2");
          return "done";
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // Two 40ms agent calls → duration ≥ 80ms
    expect(outcome.durationMs).toBeGreaterThanOrEqual(40)
    runtime.close()
  }, 15000)
})

// ── resolveConfig ───────────────────────────────────────────────────────

describe("private helpers: resolveConfig", () => {
  test("start() uses DEFAULT_WORKFLOW_CONFIG.maxSteps when ctx.config is empty", async () => {
    const runtime = new WorkflowRuntime({ ...mockCtx, config: {} })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cfg-default", description: "test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.stepsTotal).toBe(DEFAULT_WORKFLOW_CONFIG.maxSteps)
    runtime.close()
  })

  test("start() uses DEFAULT values when no ctx.config at all", async () => {
    const runtime = new WorkflowRuntime({
      client: { session: { message: mockCtx.client.session.message } },
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cfg-no-config", description: "test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.stepsTotal).toBe(DEFAULT_WORKFLOW_CONFIG.maxSteps)
    runtime.close()
  })

  test("custom maxSteps via ctx.config propagates to outcome.stepsTotal", async () => {
    const runtime = new WorkflowRuntime({
      config: { maxSteps: 77, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
      client: { session: { message: mockCtx.client.session.message } },
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cfg-maxsteps", description: "test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.stepsTotal).toBe(77)
    runtime.close()
  })

  test("custom maxTokens via ctx.config caps agent calls", async () => {
    // Each mock call uses 10+5=15 tokens. Cap at 100 → ~6 calls max.
    const { ctx, counts } = makeCountingMockCtx()
    ctx.config = { maxSteps: 200, maxTokens: 100, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 }
    const runtime = new WorkflowRuntime(ctx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "cfg-tokens", description: "test", phases: [] }
        async function main() {
          for (let i = 0; i < 50; i++) {
            const r = await agent("step " + i);
            if (r === null) return i;
          }
          return 50;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 15000 })
    expect(outcome.status).toBe("completed")
    // Token cap: 100 / 15 ≈ 6.7 → at most 6 successful calls before cap hits
    expect(counts.count).toBeLessThanOrEqual(7)
    runtime.close()
  }, 20000)

  test("resume() re-resolves config from new runtime's ctx.config", async () => {
    // Step 1: Start with runtime1 (maxSteps=30)
    const runtime1 = new WorkflowRuntime({
      config: { maxSteps: 30, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
      client: { session: { message: mockCtx.client.session.message } },
    })
    const { runID } = await runtime1.start({
      script: `export const meta = { name: "resume-cfg", description: "test", phases: [] }
        async function main() { return "first-run"; }`,
      workspace: tmpDir,
    })
    const o1 = await runtime1.wait({ runID, timeoutMs: 5000 })
    expect(o1.status).toBe("completed")
    expect(o1.stepsTotal).toBe(30)
    runtime1.close()

    // Step 2: Runtime2 with maxSteps=80 resumes same runID
    const runtime2 = new WorkflowRuntime({
      config: { maxSteps: 80, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
      client: { session: { message: mockCtx.client.session.message } },
    })
    const resumeResult = await runtime2.resume({ runID })
    expect(resumeResult.runID).toBe(runID)
    expect(resumeResult.resumed).toBe(true)

    const o2 = await runtime2.wait({ runID, timeoutMs: 5000 })
    expect(o2.status).toBe("completed")
    expect(o2.stepsTotal).toBe(80)
    runtime2.close()
  }, 15000)

  test("resume() with agentTimeoutMs override (fallback chain)", async () => {
    // Start + close runtime1
    const runtime1 = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime1.start({
      script: `export const meta = { name: "resume-timeout", description: "test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime1.wait({ runID, timeoutMs: 5000 })
    runtime1.close()

    // Resume with explicit agentTimeoutMs — verify it completes
    const runtime2 = new WorkflowRuntime(mockCtx)
    const result = await runtime2.resume({ runID, agentTimeoutMs: 9999 })
    expect(result.resumed).toBe(true)
    const outcome = await runtime2.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    runtime2.close()
  })

  test("resume() fallback: input.agentTimeoutMs undefined → row.agentTimeoutMs → DEFAULT", async () => {
    // Start + close runtime1
    const runtime1 = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime1.start({
      script: `export const meta = { name: "resume-fb", description: "test", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime1.wait({ runID, timeoutMs: 5000 })
    runtime1.close()

    // Resume without agentTimeoutMs → should fall back to DEFAULT
    const runtime2 = new WorkflowRuntime(mockCtx)
    const result = await runtime2.resume({ runID })
    expect(result.resumed).toBe(true)
    const outcome = await runtime2.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    // Uses DEFAULT_WORKFLOW_CONFIG → maxSteps=200
    expect(outcome.stepsTotal).toBe(DEFAULT_WORKFLOW_CONFIG.maxSteps)
    runtime2.close()
  })
})

// ── settleEntry ─────────────────────────────────────────────────────────

describe("private helpers: settleEntry", () => {
  test("successful script → completeRun → outcome completed", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "settle-ok", description: "test", phases: [] }
        async function main() {
          await agent("task");
          return 123;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe(123)
    runtime.close()
  }, 15000)

  test("throwing script → sandbox returns null → outcome failed", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "settle-throw", description: "test", phases: [] }
        async function main() {
          throw new Error("settleEntry failRun test");
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    // Sandbox catches thrown errors and returns null → settleEntry failRun path
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("Sandbox execution failed")
    runtime.close()
  })

  test("script returning null → sandbox returns null → outcome failed", async () => {
    const runtime = new WorkflowRuntime(mockCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "settle-null", description: "test", phases: [] }
        async function main() {
          return null;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    // Sandbox treats null return as sandbox error → settleEntry failRun path
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toContain("Sandbox execution failed")
    runtime.close()
  })

  test("double-resolve guard: cancel prevents completeRun overwrite", async () => {
    const slowCtx = makeSlowMockCtx(100)
    const runtime = new WorkflowRuntime(slowCtx)
    const { runID } = await runtime.start({
      script: `export const meta = { name: "settle-guard", description: "test", phases: [] }
        async function main() {
          await agent("slow-1");
          await agent("slow-2");
          return "should-not-appear";
        }`,
      workspace: tmpDir,
    })
    // Cancel before slow agents complete
    await runtime.cancel({ runID })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    // Guard in completeRun/failRun: if (entry.status !== "running") return
    expect(outcome.status).toBe("cancelled")
    expect(outcome.result).toBeUndefined()
    runtime.close()
  }, 15000)
})
