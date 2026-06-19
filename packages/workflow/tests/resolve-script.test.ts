// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// P1 coverage for runtime.resolveScript() — the dispatch table at
// runtime.ts:429-454 picks one of: builtin, saved workflow, inline script,
// file path, or throws. Each test exercises one branch of that dispatch.

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-resolve-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import { WorkflowPersistence } from "../src/persistence.ts"

const mockCtx: PluginContext = {
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: { input: 100, output: 50 } },
        content: [{ type: "text", text: "mock LLM response" }],
        finalText: "mock LLM response",
      }),
    },
  },
}

const p = new WorkflowPersistence({ dataDir: tmpDir })

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── P1 #11a: start({name: "tdd"}) → builtin registry hit ───────────────────
// runtime.ts:431-436 — when input.name is set and input.script is not, the
// dispatcher first tries getBuiltin(); the "tdd" builtin always exists
// (registered in builtin-registry.ts). We pass args.feature so the tdd
// script doesn't throw at the `args.feature || ""` guard.

describe("resolveScript: builtin by name", () => {
  test("start() with name resolves builtin workflow (#11a)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      name: "tdd",
      args: { feature: "resolveScript builtin dispatch test" },
      workspace: tmpDir,
    })
    expect(runID).toMatch(/^wf_[0-9A-Za-z]{26}$/)
    // Run row was created; name came from the builtin meta.
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.name).toBe("tdd")
  })
})

// ── P1 #11b: start({name: "my-wf"}) → saved workflow file ─────────────────
// runtime.ts:438-440 — when getBuiltin(name) returns undefined the dispatcher
// falls back to resolveWorkflow(name, workspace), which walks .sffmc/workflows/
// upward. We plant a saved workflow at <tmpDir>/.sffmc/workflows/my-wf.ts.

describe("resolveScript: saved workflow file by name", () => {
  test("start() with name resolves saved workflow file (#11b)", async () => {
    const workflowDir = path.join(tmpDir, ".sffmc", "workflows")
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(
      path.join(workflowDir, "my-wf.ts"),
      `export const meta = { name: "my-wf", description: "saved-wf test", phases: [] }
        async function main() { return 42; }`,
      "utf-8",
    )

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({ name: "my-wf", workspace: tmpDir })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })

    // Run completed and produced the saved script's return value.
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe(42)
    const row = p.loadRun(runID)
    expect(row!.name).toBe("my-wf")
  })
})

// ── P1 #11c: start({script: "..."}) → inline script branch ─────────────────
// runtime.ts:443-446 — when input.script starts with `export const meta`,
// isInlineScript() returns true and the script is used as-is.

describe("resolveScript: inline script", () => {
  test("start() with inline script works (#11c)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "inline-rt", description: "inline dispatch test", phases: [] }
        async function main() { return 42; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe(42)
  })
})

// ── P1 #12: start() with no meta block → throws ────────────────────────────
// runtime.ts:444-446 — `if (input.script)` only returns the script when
// `isInlineScript(input.script)` is true. A bare script without
// `export const meta` falls through to "File path" branch (input.file is
// undefined) and finally throws "workflow start requires name, script, or
// file" at runtime.ts:453. parseMeta() at runtime.ts:186 is a SECOND
// guard; whichever fires first produces a throw.

describe("resolveScript: rejects script with no meta block", () => {
  test("start() rejects script with no meta block (#12)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await expect(
      runtime.start({
        // No `export const meta` — isInlineScript returns false.
        script: "async function main() { return 99; }",
        workspace: tmpDir,
      }),
    ).rejects.toThrow()
  })
})

// ── H2: input.file path traversal ────────────────────────────────────────────
// runtime.ts:450-458 — when input.file is set, the resolved path must stay
// within the workspace root. Paths like ../../etc/passwd or /etc/shadow are
// rejected with an error.

describe("resolveScript: rejects input.file path traversal", () => {
  test("start() rejects ../../etc/passwd via input.file", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await expect(
      runtime.start({
        file: "../../etc/passwd",
        workspace: tmpDir,
      }),
    ).rejects.toThrow(/escapes workspace/i)
  })

  test("start() rejects absolute /etc/passwd via input.file", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await expect(
      runtime.start({
        file: "/etc/passwd",
        workspace: tmpDir,
      }),
    ).rejects.toThrow(/escapes workspace/i)
  })

  test("start() rejects mixed traversal ./some/dir/../../../../etc/passwd via input.file", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await expect(
      runtime.start({
        file: "./some/dir/../../../../etc/passwd",
        workspace: tmpDir,
      }),
    ).rejects.toThrow(/escapes workspace/i)
  })

  test("start() allows valid file path within workspace", async () => {
    const innerDir = path.join(tmpDir, "wf-inner")
    mkdirSync(innerDir, { recursive: true })
    writeFileSync(
      path.join(innerDir, "ok.ts"),
      `export const meta = { name: "ok-wf", description: "valid file", phases: [] }
        async function main() { return "ok"; }`,
      "utf-8",
    )
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      file: "wf-inner/ok.ts",
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("ok")
  })
})