// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Tests for Bug #1 — the dead `args` column on workflow_runs.
// Pre-fix: createRun never wrote to `args`, so loadRun().args was always
// undefined, and resume() always passed null to the guest's `args` global.
// Post-fix: createRun takes an optional args parameter; rowToRun parses
// it back; runtime passes input.args to createRun and child workflows
// inherit the parent's args.

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-args-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import {
  WorkflowPersistence,
  computeScriptSha,
} from "../src/persistence.ts"

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

const p = new WorkflowPersistence({ dataDir: tmpDir })

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Persistence layer ─────────────────────────────────────────────────────

describe("WorkflowPersistence.createRun args column", () => {
  test("createRun with object args round-trips through loadRun", () => {
    const sha = computeScriptSha("args-round-trip")
    const args = { feature: "billing", count: 3, nested: { ok: true } }
    const runID = p.createRun("a.ts", "args-round-trip", sha, undefined, undefined, args)
    const run = p.loadRun(runID)
    expect(run).not.toBeNull()
    expect(run!.args).toEqual(args)
  })

  test("createRun with array args round-trips", () => {
    const sha = computeScriptSha("args-array")
    const args = [1, "two", { three: 3 }]
    const runID = p.createRun("a.ts", "args-array", sha, undefined, undefined, args)
    const run = p.loadRun(runID)
    expect(run!.args).toEqual(args)
  })

  test("createRun with primitive args round-trips", () => {
    const sha = computeScriptSha("args-primitive")
    const runID = p.createRun("a.ts", "args-primitive", sha, undefined, undefined, "hello")
    expect(p.loadRun(runID)!.args).toBe("hello")

    const id2 = p.createRun("b.ts", "args-num", sha, undefined, undefined, 42)
    expect(p.loadRun(id2)!.args).toBe(42)
  })

  test("createRun with no args → loadRun.args is undefined", () => {
    const sha = computeScriptSha("no-args")
    const runID = p.createRun("c.ts", "no-args", sha)
    const run = p.loadRun(runID)
    expect(run).not.toBeNull()
    expect(run!.args).toBeUndefined()
  })

  test("createRun with args=null → loadRun.args is null", () => {
    // Explicit null is distinct from undefined: stored as JSON "null",
    // parsed back as the JS value null. resume() passes the parsed value
    // through to the guest, so guests can distinguish "no args" from
    // "args=null".
    const sha = computeScriptSha("args-null")
    const runID = p.createRun("d.ts", "args-null", sha, undefined, undefined, null)
    const run = p.loadRun(runID)
    expect(run).not.toBeNull()
    expect(run!.args).toBeNull()
  })
})

// ── Runtime.start() persists input.args ────────────────────────────────────

describe("WorkflowRuntime.start() persists input.args", () => {
  test("start() stores input.args on the workflow_runs row", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const args = { goal: "summarize", limit: 5 }
    const { runID } = await runtime.start({
      script: `export const meta = { name: "args-start", description: "t", phases: [] }
        async function main() { return JSON.stringify(args); }`,
      args,
      workspace: tmpDir,
    })
    const row = p.loadRun(runID)
    expect(row!.args).toEqual(args)
    // Drain
    await runtime.wait({ runID, timeoutMs: 5000 })
  })

  test("start() with no args → row.args is undefined", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "args-noargs", description: "t", phases: [] }
        async function main() { return typeof args; }`,
      workspace: tmpDir,
    })
    const row = p.loadRun(runID)
    expect(row!.args).toBeUndefined()
    await runtime.wait({ runID, timeoutMs: 5000 })
  })
})

// ── resume() round-trip ────────────────────────────────────────────────────

describe("WorkflowRuntime.resume() preserves args", () => {
  test("args survive process restart (new runtime reads from DB)", async () => {
    const args = { feature: "billing", priority: "high" }
    const originalSha = computeScriptSha("args-resume")

    // Phase 1: start with args in one runtime.
    {
      const runtime1 = new WorkflowRuntime(mockCtx, { persistence: p })
      const { runID } = await runtime1.start({
        script: `export const meta = { name: "args-resume", description: "t", phases: [] }
          async function main() { return JSON.stringify(args); }`,
        args,
        workspace: tmpDir,
      })
      // Drain to completion so the row has a stable state, then mark paused
      // to simulate an interrupted run.
      await runtime1.wait({ runID, timeoutMs: 5000 })
      p.updateRunStatus(runID, "paused")

      // Phase 1.5: verify row.args was persisted.
      const row = p.loadRun(runID)
      expect(row!.args).toEqual(args)
    }

    // Phase 2: brand-new runtime reads from DB. resume() must hand the
    // original args to settleEntry → guest.
    const runtime2 = new WorkflowRuntime(mockCtx, { persistence: p })
    // Find the run by listing — only one paused row.
    const paused = p.listRuns().filter((r) => r.status === "paused")
    expect(paused.length).toBeGreaterThan(0)
    const runID = paused[paused.length - 1].runID

    const result = await runtime2.resume({ runID })
    expect(result.resumed).toBe(true)
    const outcome = await runtime2.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    // Guest returned JSON.stringify(args) — proves the same `args` object
    // made it through resume() and into the sandbox.
    expect(outcome.result).toBe(JSON.stringify(args))
  })
})

// ── Child workflows inherit args ───────────────────────────────────────────

describe("Child workflows inherit args", () => {
  test("child workflow spawned via workflow(spec, args) sees the passed args", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const args = { feature: "auth", env: "prod" }

    // Track child runID via workflow:started event (parent's start fires
    // first, then child's start; capture both, keep the second).
    const startedRunIDs: string[] = []
    runtime.events.on("workflow:started", (e: { runID: string }) => {
      startedRunIDs.push(e.runID)
    })

    const { runID } = await runtime.start({
      script: `export const meta = { name: "args-child", description: "t", phases: [] }
        async function main() {
          // Forward parent's args to the child explicitly. This is the
          // normal pattern: workflow(spec, args) persists args on the
          // child row AND passes them as the child's guest "args" global.
          const childResult = await workflow(
            \`export const meta = { name: "args-child-inner", description: "t", phases: [] }
              async function main() { return JSON.stringify(args); }\`,
            args
          );
          return childResult;
        }`,
      args,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // Child's main() returned JSON.stringify(args) — same object as parent.
    expect(outcome.result).toBe(JSON.stringify(args))

    // Both parent and child rows should have args populated.
    const parentRow = p.loadRun(runID)
    expect(parentRow!.args).toEqual(args)
    // Identify the child by runID captured from the workflow:started event.
    expect(startedRunIDs.length).toBe(2)
    expect(startedRunIDs[0]).toBe(runID) // parent started first
    const childRunID = startedRunIDs[1]
    expect(childRunID).not.toBe(runID)
    const childRow = p.loadRun(childRunID)
    expect(childRow).not.toBeNull()
    expect(childRow!.args).toEqual(args)
  })

  test("child with no args passed → child row.args is undefined", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })

    const startedRunIDs: string[] = []
    runtime.events.on("workflow:started", (e: { runID: string }) => {
      startedRunIDs.push(e.runID)
    })

    const { runID } = await runtime.start({
      script: `export const meta = { name: "args-child-noargs", description: "t", phases: [] }
        async function main() {
          const childResult = await workflow(
            \`export const meta = { name: "args-child-noargs-inner", description: "t", phases: [] }
              async function main() { return JSON.stringify(args); }\`
          );
          return childResult;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // sandbox.ts marshals undefined args as null, so JSON.stringify yields
    // "null". This matches the historical pre-fix behavior for run-with-
    // no-args and is preserved by the bug fix.
    expect(outcome.result).toBe("null")

    // Child row should have args=undefined (the createRun column-default
    // path, since childArgs was undefined).
    expect(startedRunIDs.length).toBe(2)
    const childRunID = startedRunIDs[1]
    expect(childRunID).not.toBe(runID)
    const childRow = p.loadRun(childRunID)
    expect(childRow).not.toBeNull()
    expect(childRow!.args).toBeUndefined()
  })
})