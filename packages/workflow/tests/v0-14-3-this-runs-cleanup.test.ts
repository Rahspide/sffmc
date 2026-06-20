// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// v0.14.3 — Test scaffolding for `this.runs` map cleanup (C-2 from W10-W13 concerns).
//
// These tests DEFINE the desired v0.14.3 behavior. They will FAIL on the
// v0.14.2 baseline and PASS after the C-2 fix ships.
//
// The leak: `WorkflowRuntime.close()` currently does NOT clear `this.runs`,
// and there is no per-run deletion on settle. Every entry — completed,
// failed, cancelled, crashed — holds an mcpBridge (McpBridge with up to
// 1000 records), journalResults Map, childRunIDs Set, controller
// AbortController, and closures for the lifetime of the runtime.
//
// Fix shape (in runtime.ts):
//   - close(): add `this.runs.clear()` after the cancel loop
//   - completeRun(): add `this.runs.delete(entry.runID)` after settle
//   - failRun(): add `this.runs.delete(entry.runID)` after settle
//   - cancel(): add `this.runs.delete(entry.runID)` after settle

import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { WorkflowRuntime } from "../src/runtime.ts"
import { WorkflowPersistence } from "../src/persistence.ts"
import { makeNoClientCtx } from "./test-utils.ts"

let tmpDir: string
let persistence: WorkflowPersistence
let baseCtx: ReturnType<typeof makeNoClientCtx>

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-v143-runs-cleanup-"))
  persistence = new WorkflowPersistence({ dataDir: tmpDir })
  baseCtx = makeNoClientCtx()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// Reach the private `this.runs` map via a typed cast. This is the same
// pattern already used in w10-w14-hardcode-runtime.test.ts:122-124.
function internalRuns(runtime: WorkflowRuntime): Map<string, unknown> {
  return (runtime as unknown as { runs: Map<string, unknown> }).runs
}

describe("v0.14.3 C-2: this.runs cleanup on settle", () => {
  test("after completeRun, runID is removed from this.runs", async () => {
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cleanup-1", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5000 })
    // After completeRun, the entry must be removed from this.runs.
    expect(internalRuns(runtime).has(runID)).toBe(false)
  })

  test("after failRun, runID is removed from this.runs", async () => {
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cleanup-2", description: "t", phases: [] }
        async function main() { throw new Error("intentional"); }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("failed")
    expect(internalRuns(runtime).has(runID)).toBe(false)
  })

  test("after runtime.close(), this.runs is empty", async () => {
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "cleanup-3", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5000 })
    // The entry was already removed by completeRun, but explicit close()
    // is the second line of defense for long-lived runtimes.
    runtime.close()
    expect(internalRuns(runtime).size).toBe(0)
  })

  test("long-lived runtime with N runs does not accumulate", async () => {
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const N = 50
    const runIDs: string[] = []
    for (let i = 0; i < N; i++) {
      const { runID } = await runtime.start({
        script: `export const meta = { name: "leak-${i}", description: "t", phases: [] }
          async function main() { return "ok"; }`,
        workspace: tmpDir,
      })
      runIDs.push(runID)
      await runtime.wait({ runID, timeoutMs: 5000 })
    }
    // After all runs settled, this.runs should be empty (per-run delete on
    // completeRun). On v0.14.2 baseline, this fails with size === N.
    expect(internalRuns(runtime).size).toBe(0)
    runtime.close()
  })
})

describe("v0.14.3 C-2: mcpBridge GC after completeRun", () => {
  test("after settle, the McpBridge held by the entry is GC-eligible", async () => {
    // Soft check: after settle, the entry is removed from this.runs and
    // the McpBridge instance is no longer referenced. We can't directly
    // assert GC, but we can verify that the entry counter has stopped
    // incrementing (no leaked reference).
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "gc-1", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5000 })
    // If this.runs is properly cleared, `internalRuns(runtime).get(runID)`
    // returns undefined.
    expect(internalRuns(runtime).get(runID)).toBeUndefined()
  })
})
