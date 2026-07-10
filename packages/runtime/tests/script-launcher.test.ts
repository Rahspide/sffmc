// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Regression net for the `launchScript` module-level function, extracted
// from `runtime.ts` in the v0.16.0-SOLID wave 2 god-decomposition. The
// function is pure over its `LaunchDeps` argument + the per-run
// `entry` + `script` + `args` + `jail` — it has no `this` runtime
// reference and the sandbox runner is itself injected, so no
// `mock.module` is required (and no global mock leak to other test
// files in the same `bun test` run).

import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchScript, SCRIPT_SUFFIX } from "../src/script-launcher.ts"
import { WorkspaceJail } from "../src/workspace.ts"
import { makeEntry } from "../src/internal-run-entry.ts"
import { DEFAULT_WORKFLOW_CONFIG } from "../src/types.ts"

interface CapturedCall {
  source: string
  primitives: Record<string, unknown>
  options: { memoryMB: number; deadlineMs: number; seed: number }
}

let captured: CapturedCall | null = null
const fakeRunSandboxed = mock(async (
  source: string,
  primitives: unknown,
  options: unknown,
): Promise<unknown> => {
  captured = {
    source,
    primitives: primitives as Record<string, unknown>,
    options: options as CapturedCall["options"],
  }
  return "sentinel-result"
})

function makeFakeEntry(runID: string) {
  return makeEntry({
    runID,
    name: "test",
    cfg: {
      ...DEFAULT_WORKFLOW_CONFIG,
      maxDepth: 8,
      maxLifecycleAgents: 64,
    },
    journalResults: new Map(),
    journalPass: 0,
    workspace: mkdtempSync(join(tmpdir(), "slauncher-")),
  })
}

function makeNoopDeps() {
  return {
    spawnAgent: mock(async () => null),
    runParallel: mock(async <T,>(thunks: Array<() => Promise<T>>) =>
      Promise.all(thunks.map((t) => t().catch(() => null))),
    ),
    runPipeline: mock(async <T,>(_items: T[], _stages: unknown[]) => []),
    spawnChildWorkflow: mock(async () => null),
    setPhase: mock(() => {}),
    appendLog: mock(() => {}),
    dispatchMcpList: mock(async () => []),
    dispatchMcpCall: mock(async () => null),
    runSandboxed: fakeRunSandboxed,
    deadlineMs: 12 * 60 * 60 * 1000,
  }
}

let tmpDir: string
let entry: ReturnType<typeof makeFakeEntry>

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "slauncher-test-"))
  writeFileSync(join(tmpDir, "hello.txt"), "world")
  entry = makeFakeEntry("run-" + Math.random().toString(36).slice(2, 8))
  captured = null
  fakeRunSandboxed.mockClear()
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
  rmSync(entry.workspace!, { recursive: true, force: true })
})

describe("script-launcher.launchScript", () => {
  test("appends SCRIPT_SUFFIX to the source body so main() auto-invokes", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `export const meta = { name: "x" }\nfunction main() { return 42 }`
    await launchScript(deps, entry, script, "x", [], jail)
    expect(captured).not.toBeNull()
    expect(captured!.source).toContain(SCRIPT_SUFFIX)
    expect(captured!.source).toContain("function main()")
  })

  test("forwards the deterministic seed and config-aware constraints to runSandboxed", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `export const meta = { name: "x" }\nfunction main() {}`
    await launchScript(deps, entry, script, "x", [], jail)
    expect(captured).not.toBeNull()
    const { memoryMB, deadlineMs, seed } = captured!.options
    expect(typeof memoryMB).toBe("number")
    expect(memoryMB).toBeGreaterThan(0)
    expect(deadlineMs).toBe(12 * 60 * 60 * 1000)
    // Seed is a UInt32 derived from a SHA-1 of the runID.
    expect(seed).toBeGreaterThanOrEqual(0)
    expect(seed).toBeLessThanOrEqual(0xffffffff)
  })

  test("wires all expected primitives for the guest sandbox", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `export const meta = { name: "x" }\nfunction main() {}`
    await launchScript(deps, entry, script, "x", ["arg-1"], jail)
    expect(captured).not.toBeNull()
    const keys = Object.keys(captured!.primitives)
    for (const expected of [
      "agent",
      "parallel",
      "pipeline",
      "workflow",
      "phase",
      "log",
      "readFile",
      "writeFile",
      "glob",
      "exists",
      "mcpList",
      "mcpCall",
      "args",
    ]) {
      expect(keys).toContain(expected)
    }
    expect(captured!.primitives.args).toEqual(["arg-1"])
  })

  test("returns the value runSandboxed resolves with (passthrough)", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `export const meta = { name: "x" }\nfunction main() {}`
    fakeRunSandboxed.mockImplementationOnce(async () => "custom-payload")
    const result = await launchScript(deps, entry, script, "x", [], jail)
    expect(result).toBe("custom-payload")
  })

  test("falls back to the raw script when meta parser rejects it (no @meta)", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `function main() { return "ok" }` // no meta block
    await launchScript(deps, entry, script, "x", [], jail)
    expect(captured).not.toBeNull()
    // When the meta parser rejects, the launcher passes the raw
    // script through (not just the body).
    expect(captured!.source).toContain(script)
    expect(captured!.source).toContain(SCRIPT_SUFFIX)
  })

  test("primitives closures forward to injected deps (round-trip via globals)", async () => {
    const deps = makeNoopDeps()
    const jail = new WorkspaceJail(tmpDir)
    const script = `export const meta = { name: "x" }\nfunction main() {}`
    await launchScript(deps, entry, script, "x", [], jail)
    // Call each primitive and verify it routes to the injected dep.
    const { primitives } = captured!
    await (primitives.agent as (t: string) => Promise<unknown>)("task")
    expect(deps.spawnAgent).toHaveBeenCalledTimes(1)
    await (primitives.parallel as <T>(t: Array<() => Promise<T>>) => Promise<unknown>)([])
    expect(deps.runParallel).toHaveBeenCalledTimes(1)
    // `phase` is the guest-side name; it routes to the injected setPhase.
    ;(primitives.phase as (t: string) => void)("phase-x")
    expect(deps.setPhase).toHaveBeenCalledWith(entry, "phase-x")
    // `log` is the guest-side name; it routes to the injected appendLog.
    ;(primitives.log as (m: string) => void)("log-y")
    expect(deps.appendLog).toHaveBeenCalledWith(entry, "log-y")
  })
})
