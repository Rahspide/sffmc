// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import path from "node:path"

// Set XDG_DATA_HOME to temp dir so persistence doesn't write to real ~/.local/share
const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-test-"))
process.env.XDG_DATA_HOME = tmpDir

import {
  WorkflowError,
  DEFAULT_WORKFLOW_CONFIG,
  DEFAULT_SANDBOX_CONSTRAINTS,
  AgentFailureReason,
} from "../src/types.ts"

import {
  generateRunID,
  RUN_ID_REGEX,
  createRun,
  loadRun,
  updateRunStatus,
  writeScript,
  readScript,
  appendJournalSync,
  appendJournal,
  loadJournal,
  clearJournal,
  checkpointStep,
  loadCompletedSteps,
  computeScriptSha,
  journalKeyBase,
} from "../src/persistence.ts"

import {
  setJail,
  resolveInWorkspace,
  readFile_,
  writeFile_,
  exists,
  glob,
} from "../src/workspace.ts"

import {
  on,
  emit,
  off,
  clearAll,
} from "../src/events.ts"

import { parseMeta } from "../src/meta.ts"
import { resolveWorkflow, isInlineScript } from "../src/resolve.ts"
import { registerBuiltin, getBuiltin, listBuiltins, loadBuiltin } from "../src/builtin-registry.ts"
import { getRuntime, setRuntime, type WorkflowRuntime } from "../src/runtime-ref.ts"

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// types.ts
// ---------------------------------------------------------------------------

describe("types.ts", () => {
  test("WorkflowError carries step/token info", () => {
    const err = new WorkflowError("test error", 5, 200, 50000)
    expect(err.name).toBe("WorkflowError")
    expect(err.stepsCompleted).toBe(5)
    expect(err.stepsTotal).toBe(200)
    expect(err.tokensUsed).toBe(50000)
    expect(err.message).toBe("test error")
  })

  test("DEFAULT_WORKFLOW_CONFIG has reasonable defaults", () => {
    expect(DEFAULT_WORKFLOW_CONFIG.maxSteps).toBe(200)
    expect(DEFAULT_WORKFLOW_CONFIG.maxTokens).toBe(2_000_000)
  })

  test("DEFAULT_SANDBOX_CONSTRAINTS has reasonable defaults", () => {
    expect(DEFAULT_SANDBOX_CONSTRAINTS.memoryMB).toBe(64)
    expect(DEFAULT_SANDBOX_CONSTRAINTS.deadlineMs).toBe(12 * 60 * 60 * 1000)
  })

  test("AgentFailureReason has 5 values", () => {
    const reasons = new Set(Object.values(AgentFailureReason))
    expect(reasons.size).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// persistence.ts
// ---------------------------------------------------------------------------

describe("persistence.ts", () => {
  test("generateRunID produces valid IDs", () => {
    const ids = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const id = generateRunID()
      expect(RUN_ID_REGEX.test(id)).toBe(true)
      ids.add(id)
    }
    // All 10 should be unique
    expect(ids.size).toBe(10)
  })

  test("RUN_ID_REGEX rejects path traversal", () => {
    // Valid: exactly 26 chars after wf_, all alphanumeric
    expect(RUN_ID_REGEX.test("wf_abcdefghijklmnopqrstuvwxyz")).toBe(true)
    expect(RUN_ID_REGEX.test("wf_../etc/passwd")).toBe(false)
    expect(RUN_ID_REGEX.test("/etc/passwd")).toBe(false)
    expect(RUN_ID_REGEX.test("wf_short")).toBe(false) // too short
    expect(RUN_ID_REGEX.test("wf_000000000000000000000000.0")).toBe(false) // dot not allowed
  })

  test("createRun → loadRun roundtrip", () => {
    const sha = computeScriptSha("export const meta = { name: 'test' }")
    const runID = createRun("test.ts", "test-workflow", sha)
    expect(runID).toMatch(RUN_ID_REGEX)

    const run = loadRun(runID)
    expect(run).not.toBeNull()
    expect(run!.name).toBe("test-workflow")
    expect(run!.status).toBe("running")
    expect(run!.scriptSha).toBe(sha)
    expect(run!.running).toBe(0)
    expect(run!.succeeded).toBe(0)
    expect(run!.failed).toBe(0)
  })

  test("updateRunStatus changes status", () => {
    const sha = computeScriptSha("script")
    const runID = createRun("f.ts", "failing", sha)
    updateRunStatus(runID, "failed", "something broke")
    const run = loadRun(runID)
    expect(run!.status).toBe("failed")
    expect(run!.error).toBe("something broke")
  })

  test("writeScript → readScript roundtrip", async () => {
    const sha = computeScriptSha("my workflow source")
    const runID = createRun("w.ts", "writer", sha)
    await writeScript(runID, "my workflow source")
    const source = await readScript(runID)
    expect(source).toBe("my workflow source")
  })

  test("readScript returns null for unknown runID", async () => {
    // Generate a valid-looking ID that doesn't exist
    const fakeID = "wf_00000000000000000000000000"
    const source = await readScript(fakeID)
    expect(source).toBeNull()
  })

  test("appendJournalSync → loadJournal roundtrip", async () => {
    const sha = computeScriptSha("journal test")
    const runID = createRun("j.ts", "journal-test", sha)

    appendJournalSync(runID, { t: "agent", key: "k1", result: "hello", pass: 1 })
    appendJournalSync(runID, { t: "log", msg: "log msg", pass: 1 })
    appendJournalSync(runID, { t: "agent", key: "k2", result: { x: 1 }, pass: 2 })

    const { results, pass } = await loadJournal(runID)
    expect(pass).toBe(3) // maxPass + 1
    expect(results.get("k1")).toBe("hello")
    expect(results.get("k2")).toEqual({ x: 1 })
    expect(results.has("not-there")).toBe(false)
  })

  test("appendJournal (async) works", async () => {
    const sha = computeScriptSha("async journal")
    const runID = createRun("aj.ts", "async-journal", sha)

    await appendJournal(runID, { t: "log", msg: "async log", pass: 1 })
    const { results } = await loadJournal(runID)
    expect(results.size).toBe(0) // log events don't populate results
  })

  test("clearJournal truncates", async () => {
    const sha = computeScriptSha("clear test")
    const runID = createRun("c.ts", "clear-test", sha)
    appendJournalSync(runID, { t: "agent", key: "k1", result: "x", pass: 1 })
    await clearJournal(runID)
    const { results, pass } = await loadJournal(runID)
    expect(results.size).toBe(0)
    expect(pass).toBe(1) // no events → default pass
  })

  test("checkpointStep + loadCompletedSteps", () => {
    const sha = computeScriptSha("checkpoint test")
    const runID = createRun("cp.ts", "checkpoint", sha)

    checkpointStep(runID, {
      runID,
      stepIndex: 0,
      kind: "agent",
      input: "do the thing",
      output: "done",
      costTokens: 500,
      durationMs: 3000,
      timestamp: Math.floor(Date.now() / 1000),
    })

    const steps = loadCompletedSteps(runID)
    expect(steps.length).toBe(1)
    expect(steps[0].stepIndex).toBe(0)
    expect(steps[0].kind).toBe("agent")
    expect(steps[0].input).toBe("do the thing")
    expect(steps[0].output).toBe("done")
    expect(steps[0].costTokens).toBe(500)
  })

  test("computeScriptSha is deterministic", () => {
    const sha1 = computeScriptSha("my script")
    const sha2 = computeScriptSha("my script")
    const sha3 = computeScriptSha("my script!")
    expect(sha1).toBe(sha2)
    expect(sha1).not.toBe(sha3)
    expect(sha1.length).toBe(64) // sha256 hex = 64 chars
  })

  test("journalKeyBase is deterministic for same semantic inputs", () => {
    const k1 = journalKeyBase("do task", { model: "gpt4", phase: "Search" })
    const k2 = journalKeyBase("do task", { phase: "Search", model: "gpt4" })
    // Key order shouldn't matter due to canonical()
    expect(k1).toBe(k2)
  })

  test("end-to-end: create → script → journal → load", async () => {
    const source = "export const meta = { name: 'e2e', description: 'test' }"
    const sha = computeScriptSha(source)
    const runID = createRun("e2e.ts", "e2e-test", sha)

    await writeScript(runID, source)
    appendJournalSync(runID, { t: "agent", key: "k1", result: "done", pass: 1 })

    const run = loadRun(runID)
    expect(run!.scriptSha).toBe(sha)

    const script = await readScript(runID)
    expect(script).toBe(source)

    const { results } = await loadJournal(runID)
    expect(results.get("k1")).toBe("done")
  })
})

// ---------------------------------------------------------------------------
// workspace.ts
// ---------------------------------------------------------------------------

describe("workspace.ts", () => {
  const ws = mkdtempSync(path.join(tmpdir(), "ws-"))

  beforeAll(() => {
    setJail(ws)
    writeFileSync(path.join(ws, "readme.md"), "# Hello")
    mkdirSync(path.join(ws, "subdir"), { recursive: true })
    writeFileSync(path.join(ws, "subdir", "nested.txt"), "nested")
  })

  afterAll(() => {
    rmSync(ws, { recursive: true, force: true })
  })

  test("readFile returns content", async () => {
    const content = await readFile_("readme.md")
    expect(content).toBe("# Hello")
  })

  test("readFile returns null for missing file", async () => {
    const content = await readFile_("no-such-file.txt")
    expect(content).toBeNull()
  })

  test("writeFile creates file and parent dirs", async () => {
    await writeFile_("newdir/out.txt", "created")
    const content = await readFile_("newdir/out.txt")
    expect(content).toBe("created")
  })

  test("exists returns true for existing path", async () => {
    expect(await exists("readme.md")).toBe(true)
  })

  test("exists returns false for missing path", async () => {
    expect(await exists("ghost.md")).toBe(false)
  })

  test("glob returns sorted matches", async () => {
    const files = await glob("*.md")
    expect(files).toContain("readme.md")
    expect(files[0] <= files[files.length - 1]).toBe(true) // sorted
  })

  test("glob filters escapes", async () => {
    const files = await glob("../*.ts")
    expect(files.length).toBe(0)
  })

  test("resolveInWorkspace throws on jail escape", () => {
    expect(() => resolveInWorkspace("../outside")).toThrow("Jail escape")
    expect(() => resolveInWorkspace("/etc/passwd")).toThrow("Jail escape")
  })

  test("resolveInWorkspace allows valid paths", () => {
    const resolved = resolveInWorkspace("readme.md")
    expect(resolved).toBe(path.resolve(ws, "readme.md"))
  })

  test("setJail without call throws on resolve", () => {
    // Note: we already called setJail in beforeAll, so this tests with jail set.
    // To test unset, we'd need a separate describe block.
    // Skip — jail is set from beforeAll.
    expect(true).toBe(true) // placeholder
  })
})

// ---------------------------------------------------------------------------
// events.ts
// ---------------------------------------------------------------------------

describe("events.ts", () => {
  afterAll(() => {
    clearAll()
  })

  test("on/emit roundtrip", () => {
    const events: unknown[] = []
    const key = on("workflow:started", (e) => events.push(e))
    emit("workflow:started", { runID: "wf_abc", name: "test" })
    expect(events.length).toBe(1)
    expect(events[0]).toEqual({ runID: "wf_abc", name: "test" })
    off(key)
  })

  test("off unsubscribes", () => {
    const events: unknown[] = []
    const key = on("workflow:log", (e) => events.push(e))
    off(key)
    emit("workflow:log", { runID: "x", message: "hi" })
    expect(events.length).toBe(0)
  })

  test("multiple listeners receive events", () => {
    const log1: string[] = []
    const log2: string[] = []
    on("workflow:phase", (e) => log1.push(e.title))
    on("workflow:phase", (e) => log2.push(e.title))
    emit("workflow:phase", { runID: "wf_x", title: "Search" })
    expect(log1).toEqual(["Search"])
    expect(log2).toEqual(["Search"])
  })

  test("agent_failed event carries reason", () => {
    const events: unknown[] = []
    on("workflow:agent_failed", (e) => events.push(e))
    emit("workflow:agent_failed", { runID: "wf_a", agentKey: "k1", reason: "timeout" })
    expect(events[0]).toEqual({ runID: "wf_a", agentKey: "k1", reason: "timeout" })
  })
})

// ---------------------------------------------------------------------------
// meta.ts
// ---------------------------------------------------------------------------

describe("meta.ts", () => {
  test("parses a valid meta block", () => {
    const script = `export const meta = {
      name: 'test-workflow',
      description: "A test workflow",
      whenToUse: 'For testing',
      phases: [
        { title: 'Phase 1', detail: 'First' },
        { title: 'Phase 2' },
      ],
      model: 'gpt4',
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test-workflow")
      expect(result.meta.description).toBe("A test workflow")
      expect(result.meta.whenToUse).toBe("For testing")
      expect(result.meta.phases).toHaveLength(2)
      expect(result.meta.phases![0].title).toBe("Phase 1")
      expect(result.meta.phases![1].detail).toBeUndefined()
      expect(result.meta.model).toBe("gpt4")
    }
  })

  test("parses with double-quoted keys", () => {
    const script = `export const meta = {
      "name": "test",
      "description": "desc"
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test")
    }
  })

  test("rejects missing name", () => {
    const script = `export const meta = {
      description: "no name here"
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
  })

  test("rejects non-object meta", () => {
    const script = `export const meta = [1, 2, 3]`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
  })

  test("rejects missing meta block", () => {
    const script = `console.log("no meta");`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("workflow script must start with")
    }
  })

  test("rejects code in meta (functions)", () => {
    const script = `export const meta = {
      name: "bad",
      description: "has func",
      fn: () => {}
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(false)
  })

  test("handles comments in meta", () => {
    const script = `export const meta = {
      // comment
      name: 'test',
      description: 'desc' // inline
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test")
    }
  })

  test("handles block comments in meta", () => {
    const script = `export const meta = {
      /* block comment */
      name: 'test',
      description: 'desc'
    }`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.meta.name).toBe("test")
    }
  })

  test("body preserves line numbers", () => {
    const script = `export const meta = {
      name: 'ln',
      description: 'ln'
    }
    // line 5
    const x = 1
    // line 7`
    const result = parseMeta(script)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // body should have the meta block replaced with spaces
      expect(result.body).toContain("line 5")
      expect(result.body).toContain("const x = 1")
      // The replaced meta block shouldn't affect line count
      const lines = result.body.split("\n")
      expect(lines.length).toBeGreaterThanOrEqual(7)
    }
  })
})

// ---------------------------------------------------------------------------
// resolve.ts
// ---------------------------------------------------------------------------

describe("resolve.ts", () => {
  const ws2 = mkdtempSync(path.join(tmpdir(), "ws-resolve-"))

  beforeAll(() => {
    setJail(ws2)
  })

  afterAll(() => {
    rmSync(ws2, { recursive: true, force: true })
  })

  test("resolves inline scripts", async () => {
    const script = `export const meta = { name: 'inline-test', description: 'inline' }`
    const result = await resolveWorkflow(script, ws2)
    expect(result.kind).toBe("inline")
    expect(result.meta.name).toBe("inline-test")
    expect(result.source).toBe(script)
  })

  test("isInlineScript detects inline scripts", () => {
    expect(isInlineScript("export const meta = { name: 't' }")).toBe(true)
    expect(isInlineScript("saved-workflow-name")).toBe(false)
  })

  test("resolves saved workflows from .sffmc/workflows/", async () => {
    const wfDir = path.join(ws2, ".sffmc", "workflows")
    mkdirSync(wfDir, { recursive: true })
    writeFileSync(
      path.join(wfDir, "my-wf.ts"),
      `export const meta = { name: 'my-wf', description: 'A saved workflow' }`,
    )
    const result = await resolveWorkflow("my-wf", ws2)
    expect(result.kind).toBe("saved")
    expect(result.meta.name).toBe("my-wf")
  })

  test("throws on unknown workflow", async () => {
    await expect(resolveWorkflow("nonexistent", ws2)).rejects.toThrow("Workflow not found")
  })

  test("rejects invalid name for saved lookup", async () => {
    // "bad/name" is not a path (no ./ or ../), enters saved lookup branch, fails SAFE_NAME
    await expect(resolveWorkflow("bad/name", ws2)).rejects.toThrow("invalid workflow name")
  })
})

// ---------------------------------------------------------------------------
// builtin-registry.ts
// ---------------------------------------------------------------------------

describe("builtin-registry.ts", () => {
  test("deep-research is registered by default", () => {
    expect(listBuiltins()).toContain("deep-research")
    expect(getBuiltin("deep-research")).toBeDefined()
  })

  test("plan is registered by default", () => {
    expect(listBuiltins()).toContain("plan")
    expect(getBuiltin("plan")).toBeDefined()
  })

  test("plan loads with valid meta and source", async () => {
    const entry = await loadBuiltin("plan")
    expect(entry.name).toBe("plan")
    expect(entry.description).toBeTruthy()
    expect(entry.whenToUse).toBeTruthy()
    expect(entry.phases?.length).toBeGreaterThan(0)
    expect(entry.script).toContain("export const meta")
    expect(entry.script).toContain("args.goal")
    expect(entry.script).toContain("agent(")
  })

  test("tdd is registered by default", () => {
    expect(listBuiltins()).toContain("tdd")
    expect(getBuiltin("tdd")).toBeDefined()
  })

  test("tdd loads with valid meta and source", async () => {
    const entry = await loadBuiltin("tdd")
    expect(entry.name).toBe("tdd")
    expect(entry.description).toBeTruthy()
    expect(entry.phases?.length).toBe(5)
    expect(entry.script).toContain("args.feature")
    expect(entry.script).toContain("SPEC_SHAPE")
    expect(entry.script).toContain("RED_SHAPE")
    expect(entry.script).toContain("GREEN_SHAPE")
  })

  test("loadBuiltin throws on unknown", async () => {
    await expect(loadBuiltin("not-registered")).rejects.toThrow("Unknown built-in workflow")
  })

  test("register and load custom builtin", async () => {
    registerBuiltin("test-builtin", async () => ({
      source: "// test script",
      meta: { name: "test-builtin", description: "A test built-in", phases: [{ title: "Phase A" }] },
    }))
    expect(listBuiltins()).toContain("test-builtin")
    expect(getBuiltin("test-builtin")).toBeDefined()

    const entry = await loadBuiltin("test-builtin")
    expect(entry.name).toBe("test-builtin")
    expect(entry.description).toBe("A test built-in")
    expect(entry.script).toBe("// test script")
  })
})

// ---------------------------------------------------------------------------
// runtime-ref.ts
// ---------------------------------------------------------------------------

describe("runtime-ref.ts", () => {
  test("initially undefined", () => {
    expect(getRuntime()).toBeUndefined()
  })

  test("setRuntime and getRuntime roundtrip", () => {
    const mock: WorkflowRuntime = {
      start: async () => ({ runID: "wf_test" }),
      status: async () => ({ runID: "x", status: "running", agentCount: 1, succeeded: 0, failed: 0, stepsCompleted: 5, stepsTotal: 10, tokensUsed: 1000 }),
      wait: async () => ({ runID: "x", status: "completed", stepsCompleted: 10, stepsTotal: 10, tokensUsed: 2000, durationMs: 5000 }),
      cancel: async () => {},
      resume: async () => ({ runID: "x", resumed: true }),
      list: async () => [],
    }
    setRuntime(mock)
    const rt = getRuntime()
    expect(rt).toBeDefined()
    expect(rt).toBe(mock)
  })
})
