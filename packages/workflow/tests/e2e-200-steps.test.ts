// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, afterAll } from "bun:test"
import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/types"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-e2e-"))
process.env.XDG_DATA_HOME = tmpDir

let counter = 0

const mockCtx: PluginContext = {
  projectRoot: "/tmp",
  config: {},
  client: {
    session: {
      message: async () => {
        counter++
        return {
          info: { tokens: { input: 10, output: 5 } },
          content: [{ type: "text", text: `step-${counter}` }],
          finalText: `step-${counter}`,
        }
      },
    },
  },
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("workflow 200-step E2E", () => {
  test("runs 200 sequential agent() calls", async () => {
    counter = 0
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "200-step", description: "200 agents", whenToUse: "test", phases: [] }
        async function main() {
          const out = [];
          for (let i = 0; i < 200; i++) {
            const r = await agent("step " + i);
            out.push(r);
          }
          return out.length;
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 30000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe(200)
    expect(counter).toBe(200)
  }, 35000)

  test("lifecycle cap (1000) trips at the right step", async () => {
    counter = 0
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "over-cap", description: "over cap", whenToUse: "test", phases: [] }
        async function main() {
          const out = [];
          for (let i = 0; i < 1005; i++) {
            const r = await agent("step " + i);
            if (r === null) {
              out.push({ i: i, stopped: true });
              return out;
            }
            out.push({ i: i, r: r });
          }
          return out;
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 30000 })
    // Counter should stop at 1000 (lifecycle cap)
    expect(outcome.status).toBe("completed")
    expect(counter).toBeLessThanOrEqual(1000)
  }, 35000)

  test("token cap (2M) trips with expensive calls", async () => {
    counter = 0
    const expensiveCtx: PluginContext = {
      projectRoot: "/tmp",
      config: {},
      client: {
        session: {
          message: async () => {
            counter++
            return {
              info: { tokens: { input: 50000, output: 50000 } }, // 100k tokens each
              content: [{ type: "text", text: "expensive" }],
              finalText: "expensive",
            }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(expensiveCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "token-cap", description: "token cap", whenToUse: "test", phases: [] }
        async function main() {
          for (let i = 0; i < 100; i++) {
            const r = await agent("step " + i);
            if (r === null) return i; // stopped by cap
          }
          return 100;
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 30000 })
    // 2M tokens / 100k per call = 20 calls max
    expect(outcome.status).toBe("completed")
    expect(counter).toBeLessThanOrEqual(20)
  }, 35000)

  test("parallel agent calls complete correctly", async () => {
    counter = 0
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "parallel-test", description: "parallel agents", whenToUse: "test", phases: [] }
        async function main() {
          const results = await parallel([
            () => agent("task-0"),
            () => agent("task-1"),
            () => agent("task-2"),
          ]);
          return { count: results.length, all: results.every(r => r !== null) };
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    const result = outcome.result as { count: number; all: boolean }
    expect(result.count).toBe(3)
    expect(result.all).toBe(true)
    expect(counter).toBe(3)
  }, 15000)

  test("pipeline stages chain correctly", async () => {
    counter = 0
    const runtime = new WorkflowRuntime(mockCtx)

    const { runID } = await runtime.start({
      script: `export const meta = { name: "pipeline-test", description: "pipeline stages", whenToUse: "test", phases: [] }
        async function main() {
          const items = ["a", "b", "c"];
          const results = await pipeline(
            items,
            async (item) => {
              const r = await agent("stage-1: " + item);
              return { item: item, stage1: r };
            },
            async (prev) => {
              const r = await agent("stage-2: " + prev.item);
              return { item: prev.item, stage1: prev.stage1, stage2: r };
            }
          );
          return { count: results.length, items: results.map(r => r.item) };
        }`,
      workspace: tmpDir,
    })

    const outcome = await runtime.wait({ runID, timeoutMs: 15000 })
    expect(outcome.status).toBe("completed")
    const result = outcome.result as { count: number; items: string[] }
    expect(result.count).toBe(3)
    expect(result.items).toEqual(["a", "b", "c"])
    // 3 items × 2 stages = 6 agent calls
    expect(counter).toBe(6)
  }, 20000)
})
