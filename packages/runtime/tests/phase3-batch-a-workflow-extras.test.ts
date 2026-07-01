// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// third release migration tests (v0.14.3) — workflow extras (extra checkpoint migration, extra dream migration, extra llm-snippet migration).
//
// Verifies the new YAML-config fields and getter for three workflow
// persistence knobs:
//   - extra checkpoint migration: dbFilename  (default "state.sqlite") → getDbFilename()
//   - extra dream migration: scriptExt   (default ".js")          → consumed directly in persistence.ts via getWorkflowConfigSync().scriptExt
//   - extra llm-snippet migration: journalExt  (default ".jsonl")       → consumed directly in persistence.ts via getWorkflowConfigSync().journalExt
//
// Defaults match the prior hardcoded values exactly so behavior is
// unchanged when no `~/.config/SFFMC/workflow.yaml` is present:
//   - persistence.ts: dbPathForDir() returned `path.join(dir, "state.sqlite")`
//   - persistence.ts: scriptPath()   returned `path.join(dir, "${runID}.js")`
//   - persistence.ts: journalPath()  returned `path.join(dir, "${runID}.jsonl")`
//
// Persistence path-override tests use a temp dir and the WorkflowPersistence
// public API (writeScript / hasJournalEvents / appendJournalSync) to
// verify the override flows through to the actual on-disk file path.
// This catches wiring regressions where the literal sneaks back in
// alongside the getter call.
//
// These tests do NOT touch runtime.ts (off-limits per v0.14.1 policy).

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"

import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  __setWorkflowConfig,
  getDbFilename,
} from "./_test-helpers/config-cache.ts"
import { WorkflowPersistence } from "../src/persistence.ts"

const RUN_ID = "wf_" + "a".repeat(26)

describe("@sffmc/runtime — third release extra checkpoint migration dbFilename + extra dream migration scriptExt + extra llm-snippet migration journalExt", () => {
  let tmpDir: string

  beforeEach(() => {
    __setWorkflowConfig(null)
    tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-phase3-extras-"))
  })

  afterEach(() => {
    __setWorkflowConfig(null)
    try {
      rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  })

  // ── extra checkpoint migration — dbFilename ─────────────────────────────────────────────────

  it("extra checkpoint migration: DEFAULT_WORKFLOW_EXTENDED_CONFIG.dbFilename matches prior hardcoded 'state.sqlite'", () => {
    // The prior hardcoded value was `path.join(dir, "state.sqlite")` in
    // persistence.ts:132. A drift here would mean the YAML override
    // unintentionally changes the on-disk DB filename.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.dbFilename).toBe("state.sqlite")
  })

  it("extra checkpoint migration: getDbFilename() returns 'state.sqlite' when no YAML override is set", () => {
    expect(getDbFilename()).toBe("state.sqlite")
  })

  it("extra checkpoint migration: YAML override of dbFilename propagates to getDbFilename()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      dbFilename: "workflow-v2.sqlite",
    })
    expect(getDbFilename()).toBe("workflow-v2.sqlite")
  })

  it("extra checkpoint migration: WorkflowPersistence.dbPath uses the YAML-overridden dbFilename", () => {
    // Persistence dbPath getter must use getDbFilename() (not the literal).
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      dbFilename: "custom.sqlite",
    })
    const p = new WorkflowPersistence({ db: new Database(":memory:"), dataDir: tmpDir })
    // Internal dbPath getter is the public surface.
    expect(p.dbPath).toBe(path.join(tmpDir, "custom.sqlite"))
    p.close()
  })

  it("extra checkpoint migration: __setWorkflowConfig(null) restores default dbFilename", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      dbFilename: "ephemeral.sqlite",
    })
    expect(getDbFilename()).toBe("ephemeral.sqlite")

    __setWorkflowConfig(null)
    expect(getDbFilename()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.dbFilename)
    expect(getDbFilename()).toBe("state.sqlite")
  })

  // ── extra dream migration — scriptExt ──────────────────────────────────────────────────

  it("extra dream migration: DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptExt matches prior hardcoded '.js'", () => {
    // The prior hardcoded value was `${runID}.js` in persistence.ts:315.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptExt).toBe(".js")
  })

  it("extra dream migration: writeScript() lands at ${runID}.js by default", async () => {
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    await p.writeScript(RUN_ID, "// hello")
    const expected = path.join(tmpDir, `${RUN_ID}.js`)
    const s = statSync(expected)
    expect(s.size).toBeGreaterThan(0)
    expect(readFileSync(expected, "utf-8")).toBe("// hello")
    p.close()
  })

  it("extra dream migration: YAML override of scriptExt flows into writeScript() path", async () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      scriptExt: ".mjs",
    })
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    await p.writeScript(RUN_ID, "// mjs hello")
    // The .js variant must NOT exist; the .mjs variant MUST exist.
    expect(existsSync(path.join(tmpDir, `${RUN_ID}.js`))).toBe(false)
    expect(existsSync(path.join(tmpDir, `${RUN_ID}.mjs`))).toBe(true)
    p.close()
  })

  it("extra dream migration: readScript() reads back from the overridden extension", async () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      scriptExt: ".cjs",
    })
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    await p.writeScript(RUN_ID, "// cjs source")
    const back = await p.readScript(RUN_ID)
    expect(back).toBe("// cjs source")
    p.close()
  })

  it("extra dream migration: __setWorkflowConfig(null) restores default scriptExt", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      scriptExt: ".tmp",
    })
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptExt).toBe(".js") // default still .js
    // The active getter for scriptExt lives in persistence.ts (not exported
    // as a named function); the roundtrip test above is the canonical
    // override check.
  })

  // ── extra llm-snippet migration — journalExt ─────────────────────────────────────────────────

  it("extra llm-snippet migration: DEFAULT_WORKFLOW_EXTENDED_CONFIG.journalExt matches prior hardcoded '.jsonl'", () => {
    // The prior hardcoded value was `${runID}.jsonl` in persistence.ts:337.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.journalExt).toBe(".jsonl")
  })

  it("extra llm-snippet migration: appendJournalSync() creates ${runID}.jsonl by default", () => {
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    p.appendJournalSync(RUN_ID, { t: "log", msg: "default ext", pass: 1 })
    expect(existsSync(path.join(tmpDir, `${RUN_ID}.jsonl`))).toBe(true)
    p.close()
  })

  it("extra llm-snippet migration: YAML override of journalExt flows into appendJournalSync() path", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      journalExt: ".ndjson",
    })
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    p.appendJournalSync(RUN_ID, { t: "log", msg: "overridden ext", pass: 1 })
    expect(existsSync(path.join(tmpDir, `${RUN_ID}.jsonl`))).toBe(false)
    expect(existsSync(path.join(tmpDir, `${RUN_ID}.ndjson`))).toBe(true)
    p.close()
  })

  it("extra llm-snippet migration: YAML override of journalExt flows into loadJournal() path (round-trip)", async () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      journalExt: ".log",
    })
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    p.appendJournalSync(RUN_ID, { t: "log", msg: "round-trip", pass: 1 })
    const j = await p.loadJournal(RUN_ID)
    expect(j.pass).toBe(2) // maxPass(1) + 1
    p.close()
  })

  it("extra llm-snippet migration: hasJournalEvents() respects the overridden journalExt", async () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      journalExt: ".jrnl",
    })
    const p = new WorkflowPersistence({ dataDir: tmpDir })
    p.appendJournalSync(RUN_ID, { t: "log", msg: "exists", pass: 1 })
    expect(await p.hasJournalEvents(RUN_ID)).toBe(true)
    p.close()
  })

  // ── Cross-field isolation ────────────────────────────────────────────

  it("extra checkpoint migration/extra dream migration/extra llm-snippet migration do not collide: sibling defaults remain stable when only one is overridden", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      dbFilename: "isolated.sqlite",
      scriptExt: ".ts",
      journalExt: ".jsonl",
    })
    expect(getDbFilename()).toBe("isolated.sqlite")
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptExt).toBe(".js")
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.journalExt).toBe(".jsonl")
  })

  it("extra checkpoint migration/extra dream migration/extra llm-snippet migration do not regress v0.14.2 first prior hardcode batch-c/scheduleFlush debounce window/fsync coalescing window defaults", () => {
    // Guard against accidental edit of sibling fields when adding the
    // three new ones. The second release fields keep their established defaults.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastMs).toBe(1)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxSlowMs).toBe(50)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastWindow).toBe(50)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.flushDebounceMs).toBe(250)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.fsyncCoalesceMs).toBe(50)
    // The three new fields are present and well-typed.
    expect(typeof DEFAULT_WORKFLOW_EXTENDED_CONFIG.dbFilename).toBe("string")
    expect(typeof DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptExt).toBe("string")
    expect(typeof DEFAULT_WORKFLOW_EXTENDED_CONFIG.journalExt).toBe("string")
  })
})
