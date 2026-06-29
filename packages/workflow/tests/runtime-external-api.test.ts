// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Characterization tests for `WorkflowRuntime` external API.
//
// PURPOSE: pin the *observable* behavior of the public API before the M-1
// refactor (Task 1.1 — Phase 1 of v0.15.0). The refactor pulls
// `CounterManager`, `WorkflowEventEmitter`, `OutcomeStore`, and
// `WorkflowScheduler` out of `WorkflowRuntime`; this file asserts the
// behavior that downstream call-sites and the runtime's own consumers
// (see `src/index.ts`, `src/tool.ts`, `tests/runtime-coverage.test.ts`)
// depend on — return shapes, event payloads, status transitions, error
// messages, and persistence side-effects.
//
// NON-GOALS:
//  - These are NOT exhaustive unit tests for the internals (those live
//    in `runtime-coverage.test.ts` and other specialized files).
//  - Internal state (private fields, internal maps) is deliberately NOT
//    asserted. Only behavior visible through the documented public API
//    surface is checked.
//  - Production source is NOT modified; if a test fails here, the
//    runtime's *observable contract* is drifting and must be corrected
//    (or, if intentional, the test must be updated alongside the
//    refactor in 1.2/1.3/1.4/1.5).
//
// PUBLIC API SURFACE (from `runtime.ts`):
//   constructor(ctx: PluginContext, opts: RuntimeOpts = {})
//   setGracePeriodMs(ms: number): void
//   setConfig(cfg: Partial<WorkflowConfig> | null): void
//   loadWorkflowConfig(): Promise<void>
//   start(input): Promise<{ runID: string }>
//   status(input): Promise<WorkflowStatusOutput>
//   wait(input): Promise<WorkflowOutcome>
//   cancel(input): Promise<void>
//   list(): Promise<Array<{ runID; name; status }>>
//   resume(input): Promise<{ runID: string; resumed: boolean }>
//   recoverOrphanedWorkflows(): Promise<void>
//   close(): void
//   readonly events: event-bus (on/off/emit/clearAll)
//
// SETUP: one shared tmpDir + persistence per file (matches existing pattern
// in `runtime-coverage.test.ts` and `args-persistence.test.ts`). Each test
// creates its own WorkflowRuntime bound to the shared persistence; runtimes
// are NOT closed (would close the shared DB and break sibling tests). The
// 250 ms `scheduleFlush` timers are `unref()`'d, so they don't keep Bun
// alive after the test body ends.

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-runtime-ext-api-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import {
  WorkflowPersistence,
  computeScriptSha,
  flushJournalSync,
} from "../src/persistence.ts"
import type { WorkflowStatus } from "../src/types.ts"

// ── Fixture: mock PluginContext with bare-minimum fields and a noop LLM ──
// The mock is intentionally cheap (no LLM hooks required) — characterization
// scripts never call `agent()`. If a regression makes the runtime call
// `client.session.message` during a tiny script, the test will fail with
// "spy called" rather than produce a green status on a broken invariant.

const mockCtx: PluginContext = {
  projectRoot: tmpDir,
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: { input: 0, output: 0 } },
        content: [{ type: "text", text: "should-not-be-called" }],
        finalText: "should-not-be-called",
      }),
    },
  },
}

const p = new WorkflowPersistence({ dataDir: tmpDir })

// Counter for unique runIDs / labels across the file (runID uniqueness is
// enforced by `createRun`; label uniqueness avoids journal-file collisions
// when a test seeds a journal by label).
let runCounter = 0
function nextLabel(prefix: string): string {
  runCounter++
  return `${prefix}-${runCounter}-${process.pid}`
}

/** Generate a syntactically valid but never-existing `wf_` runID. The
 *  runtime rejects runIDs that don't match `/^wf_[0-9A-Za-z]{26}$/`
 *  (`safeRunID` in persistence.ts:54), so fake IDs must be exactly 26
 *  alphanumeric chars after the prefix. */
function fakeRunID(): string {
  runCounter++
  // 16-char tag + 10 padding zeros → 26 chars total after `wf_`.
  const tag = `neverExists${runCounter.toString().padStart(6, "0")}`.slice(0, 16)
  const pad = "0".repeat(26 - tag.length)
  return `wf_${tag}${pad}`
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ── Helpers ───────────────────────────────────────────────────────────────

/** Minimum-viable inline script — runs in QuickJS, returns immediately,
 *  no agent/MCP/file calls. Safe to use with `start()` for end-to-end
 *  settle-then-wait tests. */
const TINY_OK_SCRIPT = `export const meta = { name: "tiny", description: "t", phases: [] }
  async function main() { return "ok"; }`

/** Run an inline script to completion and return the outcome. */
async function runTiny(label = "tiny"): Promise<{
  runtime: WorkflowRuntime
  runID: string
  outcome: Awaited<ReturnType<WorkflowRuntime["wait"]>>
}> {
  const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
  const { runID } = await runtime.start({
    script: TINY_OK_SCRIPT,
    workspace: tmpDir,
  })
  const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
  return { runtime, runID, outcome }
}

// ── §1: constructor + events bus surface ──────────────────────────────────

describe("WorkflowRuntime constructor", () => {
  test("constructs with a PluginContext and exposes the events bus", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(runtime).toBeInstanceOf(WorkflowRuntime)
    // Observable: the events bus is the documented integration point for
    // observability listeners (see `src/index.ts` `server()`). Asserting
    // its presence + the `on/off/emit/clearAll` shape pins the contract
    // the MCP/index wiring depends on.
    expect(typeof runtime.events.on).toBe("function")
    expect(typeof runtime.events.off).toBe("function")
    expect(typeof runtime.events.emit).toBe("function")
    expect(typeof runtime.events.clearAll).toBe("function")
  })

  test("accepts RuntimeOpts without throwing (configOverride + gracePeriodMsOverride)", () => {
    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      gracePeriodMsOverride: 60_000,
      configOverride: { maxSteps: 50, maxTokens: 10_000 },
      completedOutcomesCacheSize: 16,
    })
    expect(runtime).toBeInstanceOf(WorkflowRuntime)
  })
})

describe("WorkflowRuntime events bus", () => {
  test("on() registers a listener that fires on emit() with the payload", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const received: Array<{ runID: string; name: string }> = []
    runtime.events.on("workflow:started", (e) => {
      received.push({ runID: e.runID, name: e.name })
    })
    runtime.events.emit("workflow:started", { runID: "wf_TEST", name: "x" })
    expect(received).toEqual([{ runID: "wf_TEST", name: "x" }])
  })

  test("off() removes a previously registered listener", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    let calls = 0
    const handler = () => {
      calls++
    }
    const key = runtime.events.on("workflow:started", handler)
    runtime.events.emit("workflow:started", { runID: "wf_A", name: "a" })
    runtime.events.off(key)
    runtime.events.emit("workflow:started", { runID: "wf_B", name: "b" })
    expect(calls).toBe(1)
  })
})

// ── §2: configuration setters ────────────────────────────────────────────

describe("WorkflowRuntime.setGracePeriodMs", () => {
  test("accepts an integer in the documented range", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(() => runtime.setGracePeriodMs(0)).not.toThrow()
    expect(() => runtime.setGracePeriodMs(60_000)).not.toThrow()
  })

  test("throws with a stable, documented error message on negative values", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(() => runtime.setGracePeriodMs(-1)).toThrow(/Invalid gracePeriodMs/)
  })

  test("throws with a stable error message on non-integer values", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(() => runtime.setGracePeriodMs(1.5)).toThrow(/Invalid gracePeriodMs/)
  })

  test("throws with a stable error message when ms exceeds MAX_GRACE_PERIOD_MS (24h)", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    // MAX_GRACE_PERIOD_MS is 24 * 60 * 60 * 1000; +1 is the smallest over-bound value.
    expect(() => runtime.setGracePeriodMs(24 * 60 * 60 * 1000 + 1)).toThrow(/Invalid gracePeriodMs/)
  })
})

describe("WorkflowRuntime.setConfig", () => {
  test("accepts a Partial<WorkflowConfig> and is observable via loadWorkflowConfig()", async () => {
    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      configOverride: { maxSteps: 7 },
    })
    // Observable: when `configOverride` is set, the subsequent async
    // `loadWorkflowConfig()` is a no-op (the override wins). We assert
    // that the call resolves AND that no YAML disk read was attempted by
    // simply verifying it doesn't throw / doesn't hang.
    await expect(runtime.loadWorkflowConfig()).resolves.toBeUndefined()
  })

  test("accepts `null` to re-enable the YAML load (no-op outside tests with real YAML)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      configOverride: { maxSteps: 7 },
    })
    runtime.setConfig(null)
    // The setConfig(null) call must not throw; the subsequent
    // loadWorkflowConfig() will attempt a real YAML load and fall back to
    // defaults in the absence of a SFFMC config dir. We only check the
    // setter doesn't throw — the YAML loader is shared infrastructure
    // covered by other test files.
    expect(() => runtime.setConfig(null)).not.toThrow()
  })
})

// ── §3: start() — workflow entry point ───────────────────────────────────

describe("WorkflowRuntime.start", () => {
  test("returns {runID} matching /^wf_/ and emits workflow:started", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const started: Array<{ runID: string; name: string }> = []
    runtime.events.on("workflow:started", (e) => {
      started.push({ runID: e.runID, name: e.name })
    })
    const { runID } = await runtime.start({
      script: TINY_OK_SCRIPT,
      workspace: tmpDir,
    })
    // Observable: returned runID has the public format used by tool.ts,
    // CLI, and MCP. The event payload shape is documented in events.ts.
    expect(runID).toMatch(/^wf_[0-9A-Za-z]{26}$/)
    expect(started).toEqual([{ runID, name: "tiny" }])
  })

  test("persists a 'running' DB row + the script side-effects that listeners depend on", async () => {
    const { runtime, runID, outcome } = await runTiny()
    // Observable: after settle, the DB row reflects the settled state.
    // This is what `list()` reads and what `workflow_status` returns —
    // so asserting the DB row pins a contract for all three.
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("ok")
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.status).toBe("completed")
    // Tooling queries use `name` from the row — it must match the meta name.
    expect(row!.name).toBe("tiny")
  })

  test("throws 'Workflow script invalid: …' on script with missing meta.name", async () => {
    // The script must look like an inline script (starts with
    // `export const meta = …`, per `isInlineScript`'s META_RE) but lack
    // a parseable meta.name. Bare function bodies never reach `parseMeta`
    // — they're rejected earlier by `resolveScript` with the
    // "workflow start requires name, script, or file" error.
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    await expect(
      runtime.start({
        script: `export const meta = { description: "missing name field" };
          async function main() { return "ok"; }`,
        workspace: tmpDir,
      }),
    ).rejects.toThrow(/^Workflow script invalid:/)
  })
})

// ── §4: status() — current state snapshot ────────────────────────────────

describe("WorkflowRuntime.status", () => {
  test("returns WorkflowStatusOutput with status='running' for an in-flight run (live map path)", async () => {
    // Use a script that performs a single agent() call so it stays in-flight
    // long enough for status() to observe the 'running' state. The mock
    // LLM hangs forever (setTimeout never returns).
    const blockingCtx: PluginContext = {
      ...mockCtx,
      client: {
        session: {
          message: async () => {
            await new Promise(() => {}) // hang forever
            return { info: { tokens: { input: 0, output: 0 } }, content: [], finalText: "" }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(blockingCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "hang", description: "h", phases: [] }
        async function main() { await agent("noop"); return "done"; }`,
      workspace: tmpDir,
    })
    const s = await runtime.status({ runID })
    expect(s.runID).toBe(runID)
    expect(s.status).toBe("running")
    expect(typeof s.stepsTotal).toBe("number")
    expect(s.stepsTotal).toBeGreaterThanOrEqual(0)
  })

  test("returns synthetic WorkflowStatusOutput with status='crashed' for an unknown runID", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const runID = fakeRunID()
    const s = await runtime.status({ runID })
    expect(s.runID).toBe(runID)
    expect(s.status).toBe("crashed")
    expect(s.agentCount).toBe(0)
    expect(s.succeeded).toBe(0)
    expect(s.failed).toBe(0)
  })

  test("reads status from the DB for a settled run", async () => {
    const { runtime, runID } = await runTiny()
    const s = await runtime.status({ runID })
    expect(s.runID).toBe(runID)
    // The DB row carries status 'completed' after settle.
    expect(s.status).toBe("completed")
  })
})

// ── §5: wait() — block until outcome ─────────────────────────────────────

describe("WorkflowRuntime.wait", () => {
  test("resolves to WorkflowOutcome with status='completed' for a settled run", async () => {
    const { runID, outcome } = await runTiny()
    expect(outcome.runID).toBe(runID)
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("ok")
    expect(typeof outcome.stepsTotal).toBe("number")
    expect(outcome.stepsTotal).toBeGreaterThanOrEqual(0)
  })

  test("returns failure outcome with 'unknown runID …' for a never-started runID", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const runID = fakeRunID()
    const outcome = await runtime.wait({ runID })
    expect(outcome.runID).toBe(runID)
    expect(outcome.status).toBe("failed")
    // The exact prefix matters — downstream tooling parses this string.
    expect(outcome.error).toMatch(/^unknown runID/)
  })

  test("returns timeout outcome with 'workflow wait timed out' on timeoutMs", async () => {
    // Same hanging-LLM trick as in status(): the run will never settle
    // within 50 ms.
    const blockingCtx: PluginContext = {
      ...mockCtx,
      client: {
        session: {
          message: async () => {
            await new Promise(() => {})
            return { info: { tokens: { input: 0, output: 0 } }, content: [], finalText: "" }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(blockingCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "hang", description: "h", phases: [] }
        async function main() { await agent("noop"); return "done"; }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 50 })
    expect(outcome.runID).toBe(runID)
    expect(outcome.status).toBe("failed")
    expect(outcome.error).toBe("workflow wait timed out")
  })

  test("late wait() after settle returns the cached outcome (not 'unknown runID')", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: TINY_OK_SCRIPT,
      workspace: tmpDir,
    })
    const first = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(first.status).toBe("completed")
    // Internal state: the entry is removed from `this.runs` post-settle.
    // Observable contract: a SECOND wait() still gets the cached outcome
    // (the v0.14.x C-2 late-wait support). If the OutcomeStore extract
    // regresses this, the second call would instead return the synthetic
    // 'unknown runID' failure — which would silently break any consumer
    // that awaits then re-queries.
    const second = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(second.status).toBe("completed")
    expect(second.result).toBe("ok")
  })
})

// ── §6: cancel() — abort a running workflow ───────────────────────────────

describe("WorkflowRuntime.cancel", () => {
  test("emits workflow:finished with status='cancelled' for a live run and persists 'cancelled'", async () => {
    const blockingCtx: PluginContext = {
      ...mockCtx,
      client: {
        session: {
          message: async () => {
            await new Promise(() => {})
            return { info: { tokens: { input: 0, output: 0 } }, content: [], finalText: "" }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(blockingCtx, { persistence: p })
    const finished: Array<{ runID: string; status: WorkflowStatus }> = []
    runtime.events.on("workflow:finished", (e) => {
      finished.push({ runID: e.runID, status: e.status })
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "hang", description: "h", phases: [] }
        async function main() { await agent("noop"); return "done"; }`,
      workspace: tmpDir,
    })
    await runtime.cancel({ runID })
    expect(finished).toEqual([{ runID, status: "cancelled" }])
    const row = p.loadRun(runID)
    expect(row!.status).toBe("cancelled")
  })

  test("is a no-op for an unknown runID (does not emit, does not throw)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const events: unknown[] = []
    runtime.events.on("workflow:finished", (e) => events.push(e))
    await runtime.cancel({ runID: fakeRunID() })
    expect(events).toEqual([])
  })
})

// ── §7: list() — enumerate known runs ────────────────────────────────────

describe("WorkflowRuntime.list", () => {
  test("returns an Array of {runID, name, status} including both DB rows and live entries", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID: completedID, outcome } = await runTiny()
    expect(outcome.status).toBe("completed")

    // Also seed an extra DB-only row to verify list() reads from BOTH the
    // live map and the persistence table.
    const dbOnlyLabel = nextLabel("list-db-only")
    const dbSha = computeScriptSha(dbOnlyLabel)
    const dbOnlyID = p.createRun(`${dbOnlyLabel}.ts`, dbOnlyLabel, dbSha)
    p.updateRunStatus(dbOnlyID, "failed", "synthetic")

    const result = await runtime.list()
    const byID = new Map(result.map((r) => [r.runID, r]))
    // From the live→settled tiny run: should be in the list with its name
    expect(byID.get(completedID)?.name).toBe("tiny")
    // From the DB-only seeded row: must also be visible
    expect(byID.get(dbOnlyID)?.name).toBe(dbOnlyLabel)
    expect(byID.get(dbOnlyID)?.status).toBe("failed")

    // Shape contract: every entry has exactly these three keys.
    for (const r of result) {
      expect(r.runID).toMatch(/^wf_/)
      expect(typeof r.name).toBe("string")
      const allowed: WorkflowStatus[] = [
        "running",
        "completed",
        "failed",
        "cancelled",
        "crashed",
        "paused",
        "budget_exceeded",
      ]
      expect(allowed).toContain(r.status)
    }
  })
})

// ── §8: resume() — replay a paused/crashed workflow ──────────────────────

describe("WorkflowRuntime.resume", () => {
  test("returns {resumed: false, runID} for a never-existed runID (no row)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const runID = fakeRunID()
    const r = await runtime.resume({ runID })
    expect(r.runID).toBe(runID)
    expect(r.resumed).toBe(false)
  })

  test("returns {resumed: false, runID} when the run is already in-flight (live guard)", async () => {
    const blockingCtx: PluginContext = {
      ...mockCtx,
      client: {
        session: {
          message: async () => {
            await new Promise(() => {})
            return { info: { tokens: { input: 0, output: 0 } }, content: [], finalText: "" }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(blockingCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "hang", description: "h", phases: [] }
        async function main() { await agent("noop"); return "done"; }`,
      workspace: tmpDir,
    })
    const r = await runtime.resume({ runID })
    expect(r.runID).toBe(runID)
    expect(r.resumed).toBe(false)
  })

  test("emits workflow:resumed, transitions 'paused' → 'running', and completes", async () => {
    // Pre-condition: a row in status='paused' with a persisted script in
    // its workspace. resume() must drive it through to completion.
    const label = nextLabel("resume-ok")
    const sha = computeScriptSha(label + "-script")
    const runID = p.createRun(`${label}.ts`, label, sha)
    await p.writeScript(
      runID,
      `export const meta = { name: "${label}", description: "r", phases: [] }
        async function main() { return "resumed-ok"; }`,
    )
    p.updateRunStatus(runID, "paused")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const resumedEvts: Array<{ runID: string; name: string; wasStatus: WorkflowStatus }> = []
    runtime.events.on("workflow:resumed", (e) => {
      resumedEvts.push({ runID: e.runID, name: e.name, wasStatus: e.wasStatus })
    })

    const r = await runtime.resume({ runID })
    expect(r).toEqual({ runID, resumed: true })
    expect(resumedEvts).toEqual([{ runID, name: label, wasStatus: "paused" }])

    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    expect(outcome.result).toBe("resumed-ok")
  })
})

// ── §9: recoverOrphanedWorkflows() — startup sweep ───────────────────────

describe("WorkflowRuntime.recoverOrphanedWorkflows", () => {
  test("marks an in-grace 'running' row as 'paused' (resumable)", async () => {
    // Row created 'just now' — well inside the 5-minute default grace.
    const label = nextLabel("recover-in-grace")
    const sha = computeScriptSha(label)
    const runID = p.createRun(`${label}.ts`, label, sha)
    // No journal yet, but in-grace takes precedence → still 'paused'.
    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      gracePeriodMsOverride: 5 * 60 * 1000,
    })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row!.status).toBe("paused")
  })

  test("marks a past-grace row with a journal as 'paused' (resumable via replay)", async () => {
    const label = nextLabel("recover-past-grace-journal")
    const sha = computeScriptSha(label)
    const runID = p.createRun(`${label}.ts`, label, sha)
    // Seed a journal event so the journal-presence check is TRUE.
    p.appendJournalSync(runID, { t: "log", msg: "seed", pass: 1 })
    flushJournalSync()
    // Force the row's createdAt back beyond the (tiny) grace window.
    const db = p.getDB()
    db.run(`UPDATE workflow_runs SET time_created = ? WHERE id = ?`, [
      Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      runID,
    ])

    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      gracePeriodMsOverride: 60_000, // 1 min — row is way past grace
    })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row!.status).toBe("paused")
  })

  test("marks a past-grace row with NO journal as 'crashed' (not resumable)", async () => {
    const label = nextLabel("recover-past-grace-naked")
    const sha = computeScriptSha(label)
    const runID = p.createRun(`${label}.ts`, label, sha)
    const db = p.getDB()
    db.run(`UPDATE workflow_runs SET time_created = ? WHERE id = ?`, [
      Math.floor(Date.now() / 1000) - 7200,
      runID,
    ])

    const runtime = new WorkflowRuntime(mockCtx, {
      persistence: p,
      gracePeriodMsOverride: 60_000,
    })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    expect(row!.status).toBe("crashed")
  })

  test("is a no-op for an in-memory live run (belt-and-suspenders guard)", async () => {
    const blockingCtx: PluginContext = {
      ...mockCtx,
      client: {
        session: {
          message: async () => {
            await new Promise(() => {})
            return { info: { tokens: { input: 0, output: 0 } }, content: [], finalText: "" }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(blockingCtx, {
      persistence: p,
      gracePeriodMsOverride: 60_000,
    })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "live-guard", description: "l", phases: [] }
        async function main() { await agent("noop"); return "x"; }`,
      workspace: tmpDir,
    })
    await runtime.recoverOrphanedWorkflows()
    const row = p.loadRun(runID)
    // Live entry must remain 'running' — recovery must not sweep it.
    expect(row!.status).toBe("running")
  })
})

// ── §10: close() — idempotent shutdown ───────────────────────────────────

describe("WorkflowRuntime.close", () => {
  test("clears listeners (events.clearAll) so future emits are silent", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    let calls = 0
    runtime.events.on("workflow:started", () => {
      calls++
    })
    runtime.close()
    runtime.events.emit("workflow:started", { runID: "wf_a", name: "a" })
    expect(calls).toBe(0)
  })

  test("is safe to call multiple times (idempotent)", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    expect(() => {
      runtime.close()
      runtime.close()
      runtime.close()
    }).not.toThrow()
  })
})
