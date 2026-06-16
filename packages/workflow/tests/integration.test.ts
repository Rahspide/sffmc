// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/types"
import { setJail } from "../src/workspace"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-integration-"))
process.env.XDG_DATA_HOME = tmpDir

const mockCtx: PluginContext = {
  projectRoot: "/tmp",
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

beforeAll(() => {
  setJail(tmpDir)
})

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
      projectRoot: "/tmp",
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
