// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import path from "node:path"

// ── Setup ──────────────────────────────────────────────────────────────────
// One shared tmpDir + persistence for the whole file. Each test gets a fresh
// runID but shares the DB/journal directory. Runtimes are created per-test
// but use the shared persistence, so we MUST NOT call runtime.close() —
// that would close the shared DB and break subsequent tests.

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-resume-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import {
  WorkflowPersistence,
  computeScriptSha,
  flushJournalSync,
} from "../src/persistence.ts"

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

const p = new WorkflowPersistence({ dataDir: tmpDir })

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRun(label: string, withJournal = false): string {
  const sha = computeScriptSha(label)
  const runID = p.createRun(`${label}.ts`, label, sha)
  if (withJournal) {
    p.appendJournalSync(runID, { t: "agent", key: "k", result: "v", pass: 1 })
    flushJournalSync()
  }
  return runID
}

function readRawJournal(runID: string): string {
  return readFileSync(path.join(tmpDir, `${runID}.jsonl`), "utf-8")
}

function readRawJournalLines(runID: string): string[] {
  return readRawJournal(runID).split("\n").filter((l) => l.length > 0)
}

// ── §1b: listRunningRuns ────────────────────────────────────────────────────

describe("persistence.listRunningRuns", () => {
  test("returns only running runs (#1)", () => {
    const r1 = makeRun("lr-1")
    const r2 = makeRun("lr-2")
    p.updateRunStatus(r2, "completed")
    const running = p.listRunningRuns()
    const ids = running.map((r) => r.runID)
    expect(ids).toContain(r1)
    expect(ids).not.toContain(r2)
    expect(running.every((r) => r.status === "running")).toBe(true)
  })

  test("excludes completed/crashed/failed/cancelled/paused (#2)", () => {
    const c = makeRun("lr-c")
    const f = makeRun("lr-f")
    const ca = makeRun("lr-ca")
    const pa = makeRun("lr-pa")
    p.updateRunStatus(c, "crashed")
    p.updateRunStatus(f, "failed")
    p.updateRunStatus(ca, "cancelled")
    p.updateRunStatus(pa, "paused")

    const running = p.listRunningRuns()
    const ids = new Set(running.map((r) => r.runID))
    expect(ids.has(c)).toBe(false)
    expect(ids.has(f)).toBe(false)
    expect(ids.has(ca)).toBe(false)
    expect(ids.has(pa)).toBe(false)
  })
})

// ── §1b: hasJournalEvents ──────────────────────────────────────────────────

describe("persistence.hasJournalEvents", () => {
  test("returns false when file missing (#3)", async () => {
    const runID = makeRun("hj-missing")
    const result = await p.hasJournalEvents(runID)
    expect(result).toBe(false)
  })

  test("returns false when file empty (#4)", async () => {
    const runID = makeRun("hj-empty")
    writeFileSync(path.join(tmpDir, `${runID}.jsonl`), "", "utf-8")
    const result = await p.hasJournalEvents(runID)
    expect(result).toBe(false)
  })

  test("returns true after first appendJournalSync (#5)", async () => {
    const runID = makeRun("hj-present")
    p.appendJournalSync(runID, { t: "agent", key: "k", result: "v", pass: 1 })
    flushJournalSync()
    const result = await p.hasJournalEvents(runID)
    expect(result).toBe(true)
  })
})

// ── §1b: appendJournalSync v1 header ───────────────────────────────────────

describe("persistence.appendJournalSync v1 header", () => {
  test("writes v1 header on first append (#6)", () => {
    const runID = makeRun("hdr-first")
    p.appendJournalSync(runID, { t: "log", msg: "first", pass: 1 })
    flushJournalSync()
    const lines = readRawJournalLines(runID)
    expect(lines.length).toBe(2) // header + 1 event
    expect(JSON.parse(lines[0])).toEqual({ v: 1 })
    expect(JSON.parse(lines[1])).toEqual({ t: "log", msg: "first", pass: 1 })
  })

  test("does NOT duplicate v1 header on subsequent appends (#7)", () => {
    const runID = makeRun("hdr-once")
    p.appendJournalSync(runID, { t: "log", msg: "a", pass: 1 })
    p.appendJournalSync(runID, { t: "log", msg: "b", pass: 2 })
    p.appendJournalSync(runID, { t: "log", msg: "c", pass: 3 })
    flushJournalSync()
    const lines = readRawJournalLines(runID)
    expect(lines.length).toBe(4) // header + 3 events
    const headerCount = lines.filter((l) => {
      try {
        const j = JSON.parse(l)
        return typeof j.v === "number" && !("t" in j)
      } catch {
        return false
      }
    }).length
    expect(headerCount).toBe(1)
  })
})

// ── §1b: loadJournal format compat ─────────────────────────────────────────

describe("persistence.loadJournal format compat", () => {
  test("parses v0 journal (no header) correctly (#8)", async () => {
    const runID = makeRun("ld-v0")
    const lines = [
      JSON.stringify({ t: "agent", key: "k1", result: "r1", pass: 1 }),
      JSON.stringify({ t: "log", msg: "l", pass: 1 }),
      JSON.stringify({ t: "agent", key: "k2", result: { x: 1 }, pass: 2 }),
    ]
    writeFileSync(path.join(tmpDir, `${runID}.jsonl`), lines.join("\n") + "\n", "utf-8")
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(3) // maxPass(2) + 1
    expect(results.get("k1")).toBe("r1")
    expect(results.get("k2")).toEqual({ x: 1 })
  })

  test("parses v1 journal (with header) correctly (#9)", async () => {
    const runID = makeRun("ld-v1")
    p.appendJournalSync(runID, { t: "agent", key: "k1", result: "v1r", pass: 1 })
    p.appendJournalSync(runID, { t: "agent", key: "k2", result: "v2r", pass: 2 })
    flushJournalSync()
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(3) // maxPass(2) + 1
    expect(results.get("k1")).toBe("v1r")
    expect(results.get("k2")).toBe("v2r")
    expect(results.has("v")).toBe(false) // header didn't pollute
  })

  test("skips v1 header and uses real event pass values (#10)", async () => {
    const runID = makeRun("ld-hdr")
    p.appendJournalSync(runID, { t: "agent", key: "k1", result: "r1", pass: 5 })
    p.appendJournalSync(runID, { t: "agent", key: "k2", result: "r2", pass: 10 })
    flushJournalSync()
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(11) // maxPass(10) + 1
    expect(results.size).toBe(2)
    expect(results.get("k1")).toBe("r1")
    expect(results.get("k2")).toBe("r2")
  })

  test("handles torn last line (truncated journal) (#11)", async () => {
    const runID = makeRun("ld-torn")
    const lines = [
      JSON.stringify({ t: "agent", key: "k1", result: "ok", pass: 1 }),
      JSON.stringify({ t: "log", msg: "l", pass: 1 }),
      '{"t":"agent","key":"k2","result":"par', // torn last line
    ]
    writeFileSync(path.join(tmpDir, `${runID}.jsonl`), lines.join("\n") + "\n", "utf-8")
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(2) // maxPass(1) + 1
    expect(results.get("k1")).toBe("ok")
    expect(results.has("k2")).toBe(false) // torn entry skipped
  })
})

// ── §1c: recoverOrphanedWorkflows ──────────────────────────────────────────
// Note: tests #12 and #13 use `gracePeriodMsOverride: 0` to bypass the workflow recovery grace period
// grace check (added in v0.14). They exercise the legacy journal-presence
// branch — the new grace behavior is covered by tests #24-#30 below.

describe("runtime.recoverOrphanedWorkflows", () => {
  test("marks running + no-journal as 'crashed' (#12)", async () => {
    const runID = makeRun("rec-crashed", false) // no journal
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 0 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("crashed")
    expect(row?.error).toContain("no journal to recover")
  })

  test("marks running + journal as 'paused' (#13)", async () => {
    const runID = makeRun("rec-paused", true) // has journal
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 0 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("paused")
    expect(row?.error).toContain("resumable from journal")
  })

  test("does not touch in-memory live runs (#14)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    // Start a real run — this populates this.runs in the runtime
    const { runID } = await runtime.start({
      script: `export const meta = { name: "live-rec", description: "t", phases: [] }
        async function main() { return "live"; }`,
      workspace: tmpDir,
    })
    // Recover — should NOT mark the live run as crashed/paused because it's in this.runs
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("running")
  })

  test("does not touch completed/failed/crashed runs (#15)", async () => {
    const cID = makeRun("rec-done")
    const fID = makeRun("rec-fail")
    const crID = makeRun("rec-crash")
    p.updateRunStatus(cID, "completed")
    p.updateRunStatus(fID, "failed")
    p.updateRunStatus(crID, "crashed")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await runtime.recoverOrphanedWorkflows()
    expect(p.loadRun(cID)?.status).toBe("completed")
    expect(p.loadRun(fID)?.status).toBe("failed")
    expect(p.loadRun(crID)?.status).toBe("crashed")
  })
})

// ── §1d: resume() 'paused' path + emit ─────────────────────────────────────

describe("runtime.resume 'paused' path", () => {
  test("resume on 'paused' workflow returns {resumed:true} and emits workflow:resumed (#16)", async () => {
    const runID = makeRun("rs-paused")
    await p.writeScript(runID, `export const meta = { name: "rs-paused", description: "t", phases: [] }
      async function main() { return "resumed"; }`)
    // Pre-populate journal so loadJournal has content
    p.appendJournalSync(runID, { t: "log", msg: "before", pass: 1 })
    flushJournalSync()
    p.updateRunStatus(runID, "paused", "resumable from journal")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    let eventFired = false
    let capturedWasStatus: string | undefined
    runtime.events.on("workflow:resumed", (e: { wasStatus: string }) => {
      eventFired = true
      capturedWasStatus = e.wasStatus
    })

    const result = await runtime.resume({ runID })
    expect(result.resumed).toBe(true)
    expect(result.runID).toBe(runID)
    expect(eventFired).toBe(true)
    expect(capturedWasStatus).toBe("paused")

    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
  })

  test("resume on 'crashed' workflow returns {resumed:true} (backward compat) (#17)", async () => {
    const runID = makeRun("rs-crashed")
    await p.writeScript(runID, `export const meta = { name: "rs-crashed", description: "t", phases: [] }
      async function main() { return "ok"; }`)
    p.updateRunStatus(runID, "crashed", "legacy")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    let capturedWasStatus: string | undefined
    runtime.events.on("workflow:resumed", (e: { wasStatus: string }) => {
      capturedWasStatus = e.wasStatus
    })

    const result = await runtime.resume({ runID })
    expect(result.resumed).toBe(true)
    expect(capturedWasStatus).toBe("crashed") // emits legacy status

    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
  })

  test("concurrent resume() calls are serialized by per-run lock (#18)", async () => {
    const runID = makeRun("rs-concurrent")
    await p.writeScript(runID, `export const meta = { name: "rs-concurrent", description: "t", phases: [] }
      async function main() { return "once"; }`)
    p.updateRunStatus(runID, "paused")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    // Fire two resume() in parallel; the per-run lock serializes them,
    // and the live-run guard makes the second one see resumed:false.
    const [r1, r2] = await Promise.all([
      runtime.resume({ runID }),
      runtime.resume({ runID }),
    ])
    const trueCount = [r1, r2].filter((r) => r.resumed).length
    expect(trueCount).toBe(1)
    expect(r1.runID).toBe(runID)
    expect(r2.runID).toBe(runID)
  })
})

// ── v0.13.0 §1: persist workspace across resume() and child workflows ──────
// schema.ts:22 + persistence.ts:createRun() now persist input.workspace to the
// workflow_runs.workspace column. resume() restores from the column instead of
// silently using process.cwd() (the pre-v0.13.0 bug). Child workflows inherit
// the parent's workspace so the entire tree stays jailed to the same root.

describe("v0.13.0 workspace persistence", () => {
  test("start() persists workspace to workflow_runs (#19)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "ws-persist", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.workspace).toBe(tmpDir)
  })

  test("start() falls back to process.cwd() when workspace omitted (#20)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "ws-default", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      // workspace omitted on purpose
    })
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.workspace).toBe(process.cwd())
  })

  test("resume() reads workspace from DB, not cwd (#21)", async () => {
    // Create a sibling dir that we will chdir into between start and resume.
    // The known file lives ONLY in tmpDir, so if resume() jails to cwd the
    // readFile call would return null and main() would fail.
    const otherDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-other-"))
    writeFileSync(path.join(tmpDir, "marker.txt"), "from-tmpDir", "utf-8")

    try {
      const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
      const { runID } = await runtime.start({
        script: `export const meta = { name: "ws-resume", description: "t", phases: [] }
          async function main() {
            const content = await readFile("marker.txt");
            return content ?? "MISSING";
          }`,
        workspace: tmpDir,
      })
      // Drain the live run before resuming.
      await runtime.wait({ runID, timeoutMs: 5000 })
      p.updateRunStatus(runID, "paused")

      // chdir away — resume() MUST NOT use cwd.
      const originalCwd = process.cwd()
      process.chdir(otherDir)
      try {
        const result = await runtime.resume({ runID })
        expect(result.resumed).toBe(true)
        const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
        expect(outcome.status).toBe("completed")
        // marker.txt only exists in tmpDir, so a successful read proves
        // resume() restored the persisted workspace.
        expect(outcome.result).toBe("from-tmpDir")
      } finally {
        process.chdir(originalCwd)
      }
    } finally {
      rmSync(otherDir, { recursive: true, force: true })
    }
  })

  test("resume() falls back to cwd + logs info on legacy row (workspace=NULL) (#22)", async () => {
    // Build a legacy row: workspace column omitted (NULL) — simulates a
    // pre-v0.13.0 run. We also need a valid script + status so resume()
    // proceeds past the early guards.
    const legacyDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-legacy-"))
    const originalLog = console.log
    let captured: string[] = []
    try {
      const sha = computeScriptSha("legacy-resume-test")
      const runID = p.createRun("legacy.ts", "legacy-ws", sha) // workspace omitted → NULL
      await p.writeScript(
        runID,
        `export const meta = { name: "legacy-ws", description: "t", phases: [] }
          async function main() { return "ok"; }`,
      )
      p.updateRunStatus(runID, "paused")

      // Capture the workflow logger's console.log output.
      captured = []
      console.log = (...args: unknown[]) => {
        captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      }
      const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
      const result = await runtime.resume({ runID })
      expect(result.resumed).toBe(true)
      // Logger uses createLogger("workflow") → console.log with "[workflow]"
      // prefix followed by the message. Look for the fallback marker.
      const found = captured.some((line) =>
        line.includes("[workflow]") &&
        line.includes(runID) &&
        line.includes("falling back to cwd"),
      )
      expect(found).toBe(true)
    } finally {
      console.log = originalLog
      rmSync(legacyDir, { recursive: true, force: true })
    }
  })

  test("startChildWorkflow() inherits parent workspace (#23)", async () => {
    // Create the marker in tmpDir (the parent's workspace) — NOT in cwd.
    writeFileSync(path.join(tmpDir, "child-marker.txt"), "child-inherited", "utf-8")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "ws-inherit-parent", description: "t", phases: [] }
        async function main() {
          const childResult = await workflow(
            \`export const meta = { name: "ws-inherit-child", description: "t", phases: [] }
              async function main() {
                const content = await readFile("child-marker.txt");
                return content ?? "MISSING";
              }\`
          );
          return childResult;
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    // The child must see tmpDir (parent's workspace), not cwd. If inheritance
    // is broken the child reads from cwd and returns "MISSING".
    expect(outcome.result).toBe("child-inherited")
  })
})

// ── v0.14 §3.8: workflow recovery grace period grace period tests (#24-#35) ────────────────────────────
// Helper: backdate a row's time_created so it appears old. The schema's
// time_created is in seconds (SQLite strftime('%s','now') convention).
function ageRun(runID: string, ageMs: number): void {
  const nowSec = Math.floor(Date.now() / 1000)
  const ageSec = Math.floor(ageMs / 1000)
  const newCreated = nowSec - ageSec
  p.getDB().run(
    "UPDATE workflow_runs SET time_created = ? WHERE id = ?",
    [newCreated, runID],
  )
}

describe("v0.14 workflow recovery grace period grace period — positive cases", () => {
  test("within grace + journal → paused (#24)", async () => {
    const runID = makeRun("g5-journal", true)
    ageRun(runID, 30_000) // 30s old
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("paused")
    expect(row?.error).toContain("within grace period")
  })

  test("within grace + no journal → paused (grace overrides journal) (#25)", async () => {
    const runID = makeRun("g5-nojournal", false)
    ageRun(runID, 30_000)
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("paused")
    expect(row?.error).toContain("within grace period")
  })

  test("past grace + journal → paused (journal preserves) (#26)", async () => {
    const runID = makeRun("g5-past-journal", true)
    ageRun(runID, 120_000) // 2 min old
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 60_000 }) // 1 min grace
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("paused")
    expect(row?.error).toContain("resumable from journal")
  })

  test("past grace + no journal → crashed (zombie) (#27)", async () => {
    const runID = makeRun("g5-past-nojournal", false)
    ageRun(runID, 120_000)
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 60_000 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("crashed")
    expect(row?.error).toContain("no journal to recover")
  })

  test("past grace (10 min) + no journal → crashed (v0.12.0 regression-lock) (#28)", async () => {
    const runID = makeRun("g5-v12", false)
    ageRun(runID, 10 * 60_000)
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("crashed")
    expect(row?.error).toContain("no journal to recover")
  })
})

describe("v0.14 workflow recovery grace period grace period — edge cases", () => {
  test("cancelled runs not touched (#29)", async () => {
    const runID = makeRun("g5-cancelled")
    ageRun(runID, 30_000) // even within grace
    p.updateRunStatus(runID, "cancelled")
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    expect(p.loadRun(runID)?.status).toBe("cancelled")
  })

  test("paused runs not re-evaluated (#30)", async () => {
    const runID = makeRun("g5-paused")
    ageRun(runID, 30_000)
    p.updateRunStatus(runID, "paused", "user-paused-before")
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row?.status).toBe("paused")
    expect(row?.error).toBe("user-paused-before") // unchanged
  })

  test("gracePeriodMs=0 behaves like v0.12.0 (#31)", async () => {
    const runID = makeRun("g5-zero")
    ageRun(runID, 60_000) // past even 0ms
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 0 })
    await runtime.recoverOrphanedWorkflows()
    // No journal → falls to crashed branch (v0.12.0 behavior)
    expect(p.loadRun(runID)?.status).toBe("crashed")
  })

  test("two concurrent recoverOrphanedWorkflows() — second is no-op (#32)", async () => {
    const runID = makeRun("g5-concurrent", true)
    ageRun(runID, 30_000)
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    // First call marks the row paused
    await runtime.recoverOrphanedWorkflows()
    expect(p.loadRun(runID)?.status).toBe("paused")
    // Second call: listRunningRuns() filters out non-running, so the row
    // is not re-evaluated. The status is unchanged from the first call.
    const errAfterFirst = p.loadRun(runID)?.error
    await runtime.recoverOrphanedWorkflows()
    expect(p.loadRun(runID)?.status).toBe("paused")
    expect(p.loadRun(runID)?.error).toBe(errAfterFirst) // unchanged
  })
})

describe("v0.14 workflow recovery grace period grace period — resume integration", () => {
  test("resume on paused-within-grace → resumed:true, wasStatus='paused' (#33)", async () => {
    const runID = makeRun("g5-resume-paused")
    ageRun(runID, 30_000)
    await p.writeScript(
      runID,
      `export const meta = { name: "g5-resume-paused", description: "t", phases: [] }
        async function main() { return "ok"; }`,
    )
    p.appendJournalSync(runID, { t: "log", msg: "pre-crash", pass: 1 })
    flushJournalSync()
    // Pre-state: row is running, age=30s. Recovery marks it paused.
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    await runtime.recoverOrphanedWorkflows()
    expect(p.loadRun(runID)?.status).toBe("paused")

    let capturedWasStatus: string | undefined
    runtime.events.on("workflow:resumed", (e: { wasStatus: string }) => {
      capturedWasStatus = e.wasStatus
    })
    const result = await runtime.resume({ runID })
    expect(result.resumed).toBe(true)
    expect(capturedWasStatus).toBe("paused")
  })

  test("resume on crashed-past-grace → resumed:true (existing backward compat) (#34)", async () => {
    const runID = makeRun("g5-resume-crashed")
    ageRun(runID, 10 * 60_000)
    await p.writeScript(
      runID,
      `export const meta = { name: "g5-resume-crashed", description: "t", phases: [] }
        async function main() { return "ok"; }`,
    )
    p.updateRunStatus(runID, "crashed", "past grace, no journal")
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p, gracePeriodMsOverride: 300_000 })
    let capturedWasStatus: string | undefined
    runtime.events.on("workflow:resumed", (e: { wasStatus: string }) => {
      capturedWasStatus = e.wasStatus
    })
    const result = await runtime.resume({ runID })
    expect(result.resumed).toBe(true)
    expect(capturedWasStatus).toBe("crashed")
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
  })

  test("setGracePeriodMs validates range (#35)", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(() => runtime.setGracePeriodMs(0)).not.toThrow()
    expect(() => runtime.setGracePeriodMs(60_000)).not.toThrow()
    expect(() => runtime.setGracePeriodMs(24 * 60 * 60 * 1000)).not.toThrow()
    expect(() => runtime.setGracePeriodMs(-1)).toThrow(/Invalid gracePeriodMs/)
    expect(() => runtime.setGracePeriodMs(24 * 60 * 60 * 1000 + 1)).toThrow(/Invalid gracePeriodMs/)
    expect(() => runtime.setGracePeriodMs(1.5)).toThrow(/Invalid gracePeriodMs/)
  })
})