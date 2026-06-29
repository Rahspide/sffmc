// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

import { makeNoClientCtx, makeToolsSpyCtx } from "./test-utils.ts"

// ── Setup ──────────────────────────────────────────────────────────────────
// One shared tmpDir + persistence for the whole file. Each test gets a fresh
// runID and a fresh WorkflowRuntime instance. Runtimes are NOT closed (would
// close the shared DB and break subsequent tests). The 250 ms scheduleFlush
// timers are unref'd, so they don't keep Node alive after the test body ends.

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-runtime-cov-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime"
import type { PluginContext } from "../src/runtime"
import { WorkflowPersistence, computeScriptSha } from "../src/persistence.ts"
import { CounterManager } from "../src/counter-manager.ts"

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

// ── #2: acquireLock() concurrent resume() serialization ─────────────────
// runtime.ts:101-112 — acquireLock chains lockMap entries. Two parallel
// resume() calls must serialize; the in-process live guard makes the second
// observe the live entry from the first and return {resumed:false}.

describe("acquireLock serialization in resume()", () => {
  test("concurrent resume() calls serialize via acquireLock, second returns {resumed:false}", async () => {
    const sha = computeScriptSha("acquireLock-concurrent-test")
    const runID = p.createRun("al.ts", "acquireLock-concurrent", sha)
    await p.writeScript(
      runID,
      `export const meta = { name: "acquireLock-concurrent", description: "t", phases: [] }
        async function main() { return "ok"; }`,
    )
    p.updateRunStatus(runID, "paused")

    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const [r1, r2] = await Promise.all([
      runtime.resume({ runID }),
      runtime.resume({ runID }),
    ])

    // Exactly one resume() wins; the other observes the live entry from the
    // first and is short-circuited by the live-run guard.
    const wins = [r1, r2].filter((r) => r.resumed)
    const loses = [r1, r2].filter((r) => !r.resumed)
    expect(wins.length).toBe(1)
    expect(loses.length).toBe(1)
    expect(r1.runID).toBe(runID)
    expect(r2.runID).toBe(runID)
    expect(loses[0].resumed).toBe(false)
  })
})

// ── #3: spawnAgent() abort check inside semaphore ──────────────────────
// runtime.ts:544-546 — when controller.signal.aborted is set, the callback
// inside globalSem.run() returns null WITHOUT calling the LLM or incrementing
// counters. We verify by firing more agents than DEFAULT_MAX_CONCURRENT and
// confirming the queued agents never reach the LLM after cancel().

describe("spawnAgent abort check inside semaphore", () => {
  test("abort check inside spawnAgent returns null when cancelled mid-semaphore", async () => {
    let llmCallCount = 0
    // LLM takes ~100 ms — enough time for cancel() to fire while agents are
    // either active in the semaphore or queued behind the max=16 active slots.
    const slowCtx: PluginContext = {
      config: {},
      client: {
        session: {
          message: async () => {
            llmCallCount++
            await new Promise((r) => setTimeout(r, 100))
            return {
              info: { tokens: { input: 10, output: 5 } },
              content: [{ type: "text", text: "ok" }],
              finalText: "ok",
            }
          },
        },
      },
    }
    const runtime = new WorkflowRuntime(slowCtx, { persistence: p })

    // Fire 30 agents in parallel — saturates the globalSem (max=16) and
    // queues the remaining 14.
    const { runID } = await runtime.start({
      script: `export const meta = { name: "abort-mid-sem", description: "t", phases: [] }
        async function main() {
          const promises = []
          for (let i = 0; i < 30; i++) {
            promises.push(agent("agent-" + i))
          }
          const results = await Promise.all(promises)
          return "done";
        }`,
      workspace: tmpDir,
    })

    // Wait long enough for all 30 to reach the semaphore (16 active, 14 queued).
    await new Promise((r) => setTimeout(r, 20))
    // Cancel: entry.controller.abort() flips the signal; queued agents will
    // see it when they enter the semaphore.
    await runtime.cancel({ runID })

    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("cancelled")
    // Queued agents (14) hit the abort check and return null without ever
    // calling the LLM. Therefore llmCallCount is bounded by DEFAULT_MAX_CONCURRENT.
    expect(llmCallCount).toBeLessThanOrEqual(16)
  })
})

// ── #4: spawnAgent() depth check ────────────────────────────────────────
// runtime.ts:549-552 — depth > maxDepth throws. The throw propagates through
// the host bridge as a promise rejection in the sandbox; the user's try/catch
// can intercept it.

describe("spawnAgent depth check", () => {
  test("agent() with depth exceeding maxDepth throws structural error", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      // Bridge translates host throws into guest promise rejections as
      // STRINGS (not Error objects) — see sandbox.ts injectHooks(). So
      // e.message is undefined; e is the raw error message string.
      script: `export const meta = { name: "depth-test", description: "t", phases: [] }
        async function main() {
          try {
            const r = await agent("task", { depth: 100 });
            return "no error";
          } catch (e) {
            return "caught: " + String(e);
          }
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    const result = String(outcome.result)
    expect(result).toContain("caught:")
    expect(result).toContain("Workflow nesting depth")
    expect(result).toContain("100")
  })
})

// ── #5: failRun() budget/deadline pattern matching ──────────────────────
// runtime.ts:837-846 — when error includes "budget_exceeded" or
// "deadline exceeded", entry.status becomes "budget_exceeded" (otherwise
// "failed"). failRun is private, so we drive it via reflection.

describe("failRun() budget_exceeded pattern matching", () => {
  test("failRun sets status to budget_exceeded when error matches budget/deadline pattern", () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const failRun = (runtime as unknown as {
      failRun: (entry: unknown, error: string) => void
    }).failRun.bind(runtime)

    function makeFakeEntry(runID: string): Record<string, unknown> {
      let resolveOutcome: (o: unknown) => void = () => {}
      const outcomePromise = new Promise<unknown>((r) => { resolveOutcome = r })
      return {
        runID,
        name: "fake",
        status: "running",
        // M-1 (Task 1.2): counter state moved into CounterManager.
        // Tests now construct an all-zero CounterManager to mirror
        // makeEntry()'s default.
        counters: new CounterManager(),
        capWarned: false,
        childRunIDs: new Set<string>(),
        startedMs: Date.now(),
        deadlineMs: Date.now() + 3_600_000,
        outcomePromise,
        resolveOutcome,
        controller: new AbortController(),
        journalResults: new Map(),
        journalPass: 0,
        cfg: {
          maxSteps: 200,
          maxTokens: 2_000_000,
          maxWallClockMs: 3_600_000,
          perStepTimeoutMs: 120_000,
          maxDepth: 8,
          maxLifecycleAgents: 1000,
        },
      }
    }

    const sha = computeScriptSha("failRun-reflection-test")

    // Case 1: "budget_exceeded" in error → status becomes "budget_exceeded"
    const r1 = p.createRun("f1.ts", "failRun-budget", sha)
    const e1 = makeFakeEntry(r1)
    failRun(e1, "Token budget_exceeded: out of money")
    expect(e1.status).toBe("budget_exceeded")
    expect(p.loadRun(r1)?.status).toBe("budget_exceeded")

    // Case 2: "deadline exceeded" in error → status becomes "budget_exceeded"
    const r2 = p.createRun("f2.ts", "failRun-deadline", sha)
    const e2 = makeFakeEntry(r2)
    failRun(e2, "workflow script deadline exceeded")
    expect(e2.status).toBe("budget_exceeded")
    expect(p.loadRun(r2)?.status).toBe("budget_exceeded")

    // Case 3: unrelated error → status becomes "failed"
    const r3 = p.createRun("f3.ts", "failRun-generic", sha)
    const e3 = makeFakeEntry(r3)
    failRun(e3, "Some random error")
    expect(e3.status).toBe("failed")
    expect(p.loadRun(r3)?.status).toBe("failed")
  })
})

// ── #6: scheduleFlush() debounced DB counter flush ─────────────────────
// runtime.ts:928-936 — multiple scheduleFlush() calls within 250 ms collapse
// into a single setTimeout. flushNow() updates running/succeeded/failed in
// the DB. We verify by checking the DB row after the debounce window elapses.

describe("scheduleFlush / flushNow DB counter flush", () => {
  test("scheduleFlush debounces and flushNow writes counters to DB", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "flush-test", description: "t", phases: [] }
        async function main() {
          await agent("task-1");
          await agent("task-2");
          return "ok";
        }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 10000 })
    // Wait past the 250 ms debounce window so flushNow() has fired.
    await new Promise((r) => setTimeout(r, 350))

    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.status).toBe("completed")
    // Two successful agents → succeeded should reflect that, not the initial 0.
    expect(row!.succeeded).toBe(2)
    expect(row!.failed).toBe(0)
    expect(row!.running).toBe(0)
  })

  // Fix-10 regression: flushNow() must NOT throw a NOT NULL constraint
  // error when the entry has undefined counter fields. Previously, tests
  // that drove internal methods via reflection built minimal fake
  // entries missing one or more of {running, succeeded, failed}. When
  // those tests triggered scheduleFlush, the 250ms timer fired with
  // an incomplete entry and bun:sqlite bound `undefined` as NULL,
  // tripping the NOT NULL constraint on workflow_runs.
  //
  // The fix has two layers:
  //   1. flushNow() coerces missing fields with `?? 0` (defensive).
  //   2. Test fake entries include all three fields (proper fix).
  //
  // This test exercises layer 1 directly by driving flushNow with a
  // minimal entry that has `undefined` for every counter.
  test("flushNow coerces undefined counters to 0 (Fix-10 NOT NULL regression)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "fix10-test", description: "t", phases: [] }
        async function main() { return "ok"; }`,
      workspace: tmpDir,
    })
    await runtime.wait({ runID, timeoutMs: 5000 })

    // Now drive flushNow directly with a minimal entry missing all
    // counter fields. The defensive `?? 0` must coerce them to 0 so
    // the UPDATE succeeds without a NOT NULL constraint error.
    const flushNow = (
      runtime as unknown as { flushNow: (e: unknown) => void }
    ).flushNow.bind(runtime)

    // Use a real runID (the one we just created) so the UPDATE matches
    // a row. Build a minimal entry with undefined counters.
    const minimalEntry = { runID, /* running, succeeded, failed all undefined */ }

    // If the `?? 0` fix is missing, this throws (caught by flushNow's
    // try/catch, logged as "flushNow DB update error"). The row would
    // not be updated to 0. With the fix, no error is logged and the
    // row's counters are set to 0.
    flushNow(minimalEntry)

    // Verify the row was updated to 0 for all counters. If the `?? 0`
    // fix were missing, the UPDATE would have thrown (caught by the
    // try/catch) and the row's counters would be unchanged from their
    // prior state (succeeded=1 after the one agent call).
    const row = p.loadRun(runID)
    expect(row).not.toBeNull()
    expect(row!.running).toBe(0)
    expect(row!.succeeded).toBe(0)
    expect(row!.failed).toBe(0)
  })
})

// ── #7: spawnChildWorkflow() structural error propagation ───────────────
// runtime.ts:685-696 — unknown workflow spec causes a throw with
// WORKFLOW_STRUCTURAL_ERROR prefix; the bridge delivers it as a rejection
// to the parent sandbox where try/catch can observe the error message.

describe("spawnChildWorkflow structural error propagation", () => {
  test("child workflow structural error propagates to parent via WORKFLOW_STRUCTURAL_ERROR", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    // Use a name that won't accidentally exist in any .sffmc/workflows/ tree.
    const UNKNOWN = "definitely-nonexistent-wf-xyz-98765"
    const { runID } = await runtime.start({
      // Bridge translates host throws into guest promise rejections as
      // STRINGS (not Error objects) — see sandbox.ts injectHooks().
      script: `export const meta = { name: "child-struct-err", description: "t", phases: [] }
        async function main() {
          try {
            const r = await workflow("${UNKNOWN}");
            return "no error";
          } catch (e) {
            return "caught: " + String(e);
          }
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 10000 })
    expect(outcome.status).toBe("completed")
    const result = String(outcome.result)
    expect(result).toContain("caught:")
    expect(result).toContain("WorkflowStructuralError")
    expect(result).toContain(UNKNOWN)
  })
})

// ── #8: callLLM() fallback when no LLM client ──────────────────────────
// runtime.ts:790-804 — when ctx.client?.session?.message is undefined,
// callLLM returns the fallback text "workflow: no LLM client available"
// instead of throwing. The deliverable extraction in executeAgentCall then
// sees no .structured / .finalText and the agent call returns null. We
// invoke callLLM directly via reflection so the test is independent of
// executeAgentCall's deliverable logic.

describe("callLLM fallback when no LLM client", () => {
  test("callLLM returns fallback text when ctx.client.session.message is unavailable (#8)", async () => {
    const ctxNoClient = makeNoClientCtx()
    const runtime = new WorkflowRuntime(ctxNoClient, { persistence: p })
    const callLLM = (
      runtime as unknown as {
        callLLM: (
          entry: unknown,
          prompt: string,
          opts: unknown,
        ) => Promise<{
          content: Array<{ type: string; text?: string }>
          info?: unknown
          structured?: unknown
          finalText?: string
        }>
      }
    ).callLLM.bind(runtime)

    // Minimal entry shape — callLLM does not touch entry state.
    const fakeEntry = { runID: "wf_x", cfg: { maxTokens: 100 } }
    const result = await callLLM(fakeEntry, "any prompt", {})
    expect(Array.isArray(result.content)).toBe(true)
    expect(result.content[0].type).toBe("text")
    expect(result.content[0].text).toBe("workflow: no LLM client available")
    // No tokens / structured / finalText on the fallback path.
    expect(result.info).toBeUndefined()
    expect(result.structured).toBeUndefined()
    expect(result.finalText).toBeUndefined()
  })
})

// ── #9: executeAgentCall() structured extract on schema ────────────────
// runtime.ts:612-614 — when opts.schema is set, deliverable is
// result.structured (not result.finalText). We mock session.message to
// return both .structured and .finalText and assert the structured value
// wins. Invoked via reflection because executeAgentCall is private.

describe("executeAgentCall schema-based structured extract", () => {
  test("executeAgentCall returns result.structured when opts.schema is set (#9)", async () => {
    const spyCtx: PluginContext = {
      config: {},
      client: {
        session: {
          message: async () => ({
            // No info → tokens=0, no over-cap concern.
            content: [],
            structured: { ok: 1 },
            finalText: "raw text",
          }),
        },
      },
    }
    const runtime = new WorkflowRuntime(spyCtx, { persistence: p })
    const executeAgentCall = (
      runtime as unknown as {
        executeAgentCall: (
          entry: unknown,
          prompt: string,
          o: unknown,
          key: string,
        ) => Promise<unknown>
      }
    ).executeAgentCall.bind(runtime)

    // Fake entry mirroring the InternalRunEntry fields executeAgentCall reads.
    // runID MUST match RUN_ID_REGEX (^wf_[0-9A-Za-z]{26}$) — executeAgentCall
    // calls appendJournalSync on success, and persistence throws on bad IDs.
    const sha = computeScriptSha("schema-extract-test")
    const runID = p.createRun("s.ts", "schema-extract", sha)
    // Fix-10: include `failed: 0` (and all other flushNow fields) on
    // the fake entry. executeAgentCall's success path calls
    // `this.scheduleFlush(entry)`, which captures the entry in a 250ms
    // setTimeout. When the timer fires, `flushNow` reads these fields
    // — if any are `undefined`, bun:sqlite binds them as NULL and
    // trips the NOT NULL constraint on `workflow_runs`. The runtime
    // now has a defensive `?? 0` in flushNow, but the test fake entry
    // should still mirror the full InternalRunEntry shape to avoid
    // silent data masking.
    // M-1 (Task 1.2): the test fake entry now owns counters via a
    // CounterManager instance, mirroring makeEntry()'s shape. The
    // pre-task entry had flat `running: 1, succeeded: 0, …` fields;
    // post-task the same logical state lives on `entry.counters`.
    const fakeEntry = {
      runID,
      // Running=1 reflects that an agent is "in flight" when
      // executeAgentCall is invoked (matches the previous flat-field
      // shape). recordAgentSucceed() will decrement running and
      // increment succeeded.
      counters: Object.assign(new CounterManager(), { running: 1 }),
      journalPass: 1,
      cfg: { maxTokens: 2_000_000 },
    }

    const result = await executeAgentCall(
      fakeEntry,
      "schema prompt",
      { schema: { type: "object" } },
      "k1",
    )
    // schema branch returns result.structured verbatim.
    expect(result).toEqual({ ok: 1 })
    // Succeed counter ticked; running decremented (now on CounterManager).
    expect(fakeEntry.counters.succeeded).toBe(1)
    expect(fakeEntry.counters.running).toBe(0)
  })
})

// ── #13a/b: callLLM() tools field forwarding ───────────────────────────
// runtime.ts:794 — `tools: opts.tools ? [...opts.tools] as string[] : "INHERIT"`.
// Two cases: undefined → literal string "INHERIT"; defined array → shallow
// copy as string[]. Tested via reflection on callLLM + a spy ctx.

describe("callLLM tools forwarding", () => {
  test("callLLM inherits tools when opts.tools is undefined (#13a)", async () => {
    const spy = makeToolsSpyCtx()
    const runtime = new WorkflowRuntime(spy, { persistence: p })
    const callLLM = (
      runtime as unknown as {
        callLLM: (
          entry: unknown,
          prompt: string,
          opts: unknown,
        ) => Promise<unknown>
      }
    ).callLLM.bind(runtime)

    const fakeEntry = { runID: "wf_x", cfg: { maxTokens: 100 } }
    await callLLM(fakeEntry, "p", {})

    expect(spy.calls.length).toBe(1)
    // Sentinel preserved exactly — downstream uses === "INHERIT" check.
    expect(spy.calls[0].tools).toBe("INHERIT")
  })

  test("callLLM passes tools array to session.message (#13b)", async () => {
    const spy = makeToolsSpyCtx()
    const runtime = new WorkflowRuntime(spy, { persistence: p })
    const callLLM = (
      runtime as unknown as {
        callLLM: (
          entry: unknown,
          prompt: string,
          opts: unknown,
        ) => Promise<unknown>
      }
    ).callLLM.bind(runtime)

    const fakeEntry = { runID: "wf_x", cfg: { maxTokens: 100 } }
    const wanted = ["read_file", "glob"]
    await callLLM(fakeEntry, "p", { tools: wanted })

    expect(spy.calls.length).toBe(1)
    // Forwarded as a NEW array (spread) — runtime never mutates caller's array.
    expect(spy.calls[0].tools).toEqual(wanted)
    expect(spy.calls[0].tools).not.toBe(wanted) // identity check: spread copies
  })
})

// ── #17: completeRun() — undefined main() return ────────────────────────
// runtime.ts:840-850, settleEntry() — when main() returns nothing the
// outcome carries `result: undefined` (not the string "undefined"). Status
// still flips to "completed". Drives the full pipeline through start().

describe("completeRun undefined result", () => {
  test("script returning undefined produces outcome.result undefined (#17)", async () => {
    const runtime = new WorkflowRuntime(mockCtx, { persistence: p })
    const { runID } = await runtime.start({
      // async function main with NO return → main() resolves to undefined.
      script: `export const meta = { name: "no-return", description: "t", phases: [] }
        async function main() { /* no return */ }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    // outcomeFor() spreads `extras?.result` (undefined) — not the literal
    // string "undefined", not null. Use hasOwnProperty check to assert the
    // key exists but the value is undefined.
    expect("result" in outcome).toBe(true)
    expect(outcome.result).toBeUndefined()
  })
})