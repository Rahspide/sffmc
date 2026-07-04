// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearAll, off } from "@sffmc/utilities"
import { __setWorkflowConfig } from "./_test-helpers/config-cache.ts"
import { startWorkflowWatcher } from "../src/workflow-watcher.ts"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-watcher-"))
  __setWorkflowConfig(null)
  clearAll()
})

afterEach(() => {
  clearAll()
  if (existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

describe("startWorkflowWatcher", () => {
  test("returns handle with stop()", () => {
    const handle = startWorkflowWatcher(tmpDir)
    expect(typeof handle.stop).toBe("function")
    handle.stop()
  })

  test("missing workflow subdirs are tolerated (skipped, not thrown)", () => {
    // tmpDir has no .sffmc/workflows/ — watcher should skip silently
    const handle = startWorkflowWatcher(tmpDir)
    expect(handle.stop).toBeDefined()
    handle.stop()
  })

  test("emits workflow:file-changed when workflow file is added", async () => {
    const workflowsDir = join(tmpDir, ".sffmc", "workflows")
    mkdirSync(workflowsDir, { recursive: true })

    const handle = startWorkflowWatcher(tmpDir)
    // Allow watcher to register before we mutate
    await new Promise((r) => setTimeout(r, 50))

    // Subscribe to the event; the watcher fires synchronously via the
    // events bus after fs.watch fires (async).
    let captured: { event: string; path: string } | null = null
    const { on } = await import("@sffmc/utilities")
    on("workflow:file-changed", (e: { event: string; path: string }) => {
      captured = e
    })

    // Write a workflow file
    writeFileSync(join(workflowsDir, "my_workflow.ts"), "export const meta = {}\n")

    // Wait for fs.watch to fire and the event to propagate.
    // Poll up to 2s — Linux fs.watch has variable latency.
    const deadline = Date.now() + 2000
    while (!captured && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }

    handle.stop()

    expect(captured).not.toBeNull()
    expect(captured!.event).toBe("add")
    expect(captured!.path).toContain("my_workflow.ts")
  })

  test("filters out non-script files", async () => {
    const workflowsDir = join(tmpDir, ".sffmc", "workflows")
    mkdirSync(workflowsDir, { recursive: true })

    const handle = startWorkflowWatcher(tmpDir)
    await new Promise((r) => setTimeout(r, 50))

    let fired = false
    const { on } = await import("@sffmc/utilities")
    on("workflow:file-changed", () => {
      fired = true
    })

    writeFileSync(join(workflowsDir, "readme.md"), "# not a workflow")
    await new Promise((r) => setTimeout(r, 200))

    handle.stop()
    expect(fired).toBe(false)
  })

  test("stop() is idempotent", () => {
    const handle = startWorkflowWatcher(tmpDir)
    handle.stop()
    // Should not throw on second call.
    expect(() => handle.stop()).not.toThrow()
  })
})