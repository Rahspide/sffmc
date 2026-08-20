// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// coverage for runtime.spawnChildWorkflow() — specifically the journal
// replay branch (runtime.ts:690-695) that fires when a parent workflow
// invokes `workflow(spec, args)` with a (spec, args) hash it has already
// produced in a previous call within the same run. The hash key is
// `wf:<sha256({spec, args})>:occ` where occ is the per-(spec,args) call
// counter.

import { describe, test, expect, afterAll } from "bun:test"
import * as v from "valibot"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { createHash } from "node:crypto"
import path from "node:path"

/** Valibot schema for "any JSON-serializable value" — the union of
 *  primitives, arrays, and records. Source of truth for the spawn
 *  entry/args/result types. */
const SpawnJsonValueSchema = v.union([
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.unknown()),
  v.record(v.string(), v.unknown()),
]);

/** Test-only domain aliases — derive from the JSON-value schema so
 *  the no-unknown-parameters and no-unknown-returns rules see
 *  concrete domain types (the rule follows `type X = …` aliases to
 *  their underlying type). */
type TestSpawnEntry = v.InferOutput<typeof SpawnJsonValueSchema>;
type TestSpawnArgs = v.InferOutput<typeof SpawnJsonValueSchema>;
type TestSpawnResult = v.InferOutput<typeof SpawnJsonValueSchema>;

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-spawn-child-"))
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

// ── #10: spawnChildWorkflow() journal-hit branch ───────────────────────
// runtime.ts:691-695 — when entry.journalResults.has(key) is true on a
// subsequent identical workflow() call, spawnChildWorkflow returns the
// cached value, bumps succeeded, and NEVER launches a child. We pre-seed
// the SECOND call's key (occ=1) so the first call (occ=0) actually
// launches and the second call hits the journal.

describe("spawnChildWorkflow journal replay", () => {
  test("child workflow journal replay returns cached result on second identical call (#10)", async () => {
    // Plant a saved workflow that returns a known value WITHOUT needing args.
    const workflowDir = path.join(tmpDir, ".sffmc", "workflows")
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(
      path.join(workflowDir, "jwf.ts"),
      `export const meta = { name: "jwf", description: "journal replay child", phases: [] }
        async function main() { return "child-ran"; }`,
      "utf-8",
    )

    // resolveWorkflow() uses process.cwd() as the search root — chdir to tmpDir
    // so "jwf" resolves to tmpDir/.sffmc/workflows/jwf.ts.
    const originalCwd = process.cwd()
    process.chdir(tmpDir)

    try {
      const runtime = new WorkflowRuntime(mockCtx, { persistence: p })

      // Compute the journal key the SECOND workflow() call would use.
      // Key format from runtime.ts:683-688:
      //   base = sha256(JSON.stringify({ spec, args: childArgs ?? null }))
      //   key  = "wf:" + base + ":" + occ
      const spec = "jwf"
      const childArgs = null
      const base = createHash("sha256")
        .update(JSON.stringify({ spec, args: childArgs }))
        .digest("hex")
      // 1st call: occ=0 → "wf:<base>:0"
      // 2nd call: occ=1 → "wf:<base>:1"  ← we pre-seed THIS key
      const secondCallKey = `wf:${base}:1`

      // Fake entry with the second-call result pre-seeded. We need a real
      // runID so the FIRST call can appendJournalSync on success
      // (persistence rejects malformed runIDs).
      const sha = computeScriptSha("journal-replay-parent")
      const fakeRunID = p.createRun("parent.ts", "jr-parent", sha)

      // SAFETY: test fixture; fake entry is intentionally partial — it only mirrors the subset of InternalRunEntry fields used by the journal-replay parent path; `as any` is the documented escape hatch for the structural mismatch
      const fakeEntry = {
        runID: fakeRunID,
        // Fix-10: include a CounterManager on the fake entry so
        // scheduleFlush → flushNow doesn't see `entry.counters` as
        // undefined. The runtime now has a defensive `?.running ?? 0`
        // in flushNow, but the test fake entry should still mirror
        // the full InternalRunEntry shape to avoid silent data
        // masking. M-1 (Task 1.2) moved the counter fields onto
        // CounterManager — pre-task this object had flat
        // `running: 0, succeeded: 0, failed: 0` fields.
        counters: new CounterManager(),
        childRunIDs: new Set<string>(),
        journalResults: new Map<string, unknown>([
          [secondCallKey, "from-journal"],
        ]),
        // Required for spawnChildWorkflow → startChildWorkflow → makeEntry,
        // which reads cfg.maxWallClockMs to set the child deadline.
        cfg: {
          maxSteps: 200,
          maxTokens: 2_000_000,
          maxWallClockMs: 3_600_000,
          perStepTimeoutMs: 120_000,
          maxDepth: 8,
          maxLifecycleAgents: 1000,
        },
      // @ts-expect-error - fake entry intentionally omits non-optional fields required by the test surface
      } as Parameters<typeof runtime["spawnChildWorkflow"]>[0]

      // SAFETY: test uses reflection to access the private `spawnChildWorkflow` method; `as any` is the documented escape hatch (called via .bind to preserve `this`)
      const spawnChildWorkflow = (runtime as any).spawnChildWorkflow.bind(runtime) as (
        entry: TestSpawnEntry,
        nameOrScript: string,
        childArgs: TestSpawnArgs,
        workflowOcc: Map<string, number>,
      ) => Promise<TestSpawnResult>

      const occ = new Map<string, number>()
      const r1 = await spawnChildWorkflow(fakeEntry, spec, childArgs, occ)
      const r2 = await spawnChildWorkflow(fakeEntry, spec, childArgs, occ)

      // First call: not in journal → child launched → returns "child-ran".
      // Second call: journal hit → returns "from-journal", NO child launch.
      // The distinct values prove which branch fired.
      expect(r1).toBe("child-ran")
      expect(r2).toBe("from-journal")
      // succeeded++ fires only on the JOURNAL-HIT branch (runtime.ts:692).
      // The launch path returns the child outcome without touching parent
      // succeeded. So 1 child = 1 increment.
      // M-1 (Task 1.2): succeeded now lives on entry.counters.
      expect(fakeEntry.counters.succeeded).toBe(1)
      // Exactly ONE child was launched — the second call bypassed
      // startChildWorkflow entirely. childRunIDs grows in spawnChildWorkflow
      // line 713 right before launching.
      expect(fakeEntry.childRunIDs.size).toBe(1)
      // occ counter advanced twice (one increment per call).
      expect(occ.get(base)).toBe(2)
    } finally {
      process.chdir(originalCwd)
    }
  })
})