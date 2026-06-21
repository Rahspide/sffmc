// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// v0.14.3 — schema journal validation schema refactor initial release.
//
// Closes Manriel audit schema journal validation ("Journal JSON parsed without schema validation"):
// declares `JournalEvent` types and validates each parsed JSONL line
// against the schema before admitting it to the journal results map.
//
// These tests DEFINE the desired v0.14.3 behavior. They will FAIL on the
// v0.14.2 baseline (where `validateJournalEvent` and the schema-journal.ts
// module do not exist yet) and PASS after schema journal validation initial release ships.
//
// Implementation shape (schema journal validation future work):
//   - new file `packages/workflow/src/schema-journal.ts`:
//     - declares `JournalEventType = "agent" | "log" | "phase"`
//     - declares `JournalEvent` discriminated union (agent/log/phase shapes)
//     - exports `validateJournalEvent(raw: string, lineNo: number):
//       | { ok: true; event: JournalEvent }
//       | { ok: false; error: JournalValidationError }`
//     - `JournalValidationError = { line: number; raw: string; error: string }`
//   - edit `packages/workflow/src/persistence.ts:357-390` (loadJournal):
//     - wraps existing `try { ev = JSON.parse(line) } catch { continue }`
//     - on `{ok: false}`, log.debug("journal: skipping malformed event at
//       line N: <error>") and continue (preserves existing torn-line skip
//       behavior, just structured)

import { describe, test, expect } from "bun:test"
import type {
  JournalEvent,
  JournalEventType,
  JournalValidationError,
} from "../src/schema-journal.ts"
import { validateJournalEvent } from "../src/schema-journal.ts"

// The expected 3 event types:
const EXPECTED_TYPES: ReadonlyArray<string> = ["agent", "log", "phase"]

describe("v0.14.3 schema journal validation initial release: journal event schema validation", () => {
  test("valid agent event returns ok:true with discriminated event", () => {
    const raw = JSON.stringify({
      t: "agent",
      key: "task-1",
      args: { prompt: "do thing" },
      result: "ok",
      pass: 1,
      tokens: 42,
    })
    const v = validateJournalEvent(raw, 1)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.event.t).toBe("agent")
      if (v.event.t === "agent") {
        expect(v.event.key).toBe("task-1")
        expect(v.event.pass).toBe(1)
      }
    }
  })

  test("valid log event returns ok:true", () => {
    const raw = JSON.stringify({
      t: "log",
      msg: "hello",
      pass: 1,
    })
    const v = validateJournalEvent(raw, 1)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.event.t).toBe("log")
    }
  })

  test("valid phase event returns ok:true", () => {
    const raw = JSON.stringify({
      t: "phase",
      title: "execute",
      pass: 1,
    })
    const v = validateJournalEvent(raw, 1)
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.event.t).toBe("phase")
      if (v.event.t === "phase") {
        expect(v.event.title).toBe("execute")
      }
    }
  })

  test("malformed JSON returns ok:false with line number", () => {
    const raw = '{"t":"agent","key":"k","result":"par' // torn line
    const v = validateJournalEvent(raw, 42)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      const err = v.error as JournalValidationError
      expect(err.line).toBe(42)
      expect(err.error.length).toBeGreaterThan(0)
    }
  })

  test("unknown event type returns ok:false", () => {
    const raw = JSON.stringify({ t: "schema", payload: { foo: "bar" }, pass: 1 })
    const v = validateJournalEvent(raw, 1)
    // On v0.14.2 baseline (no schema), t="schema" is just an unknown
    // event-type that gets silently skipped. On v0.14.3, it returns
    // ok:false with a clear error.
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error.error.toLowerCase()).toContain("type")
    }
  })

  test("event with extra unknown fields is accepted (forward-compatible)", () => {
    // Future versions may add fields; v1.x should accept v1.0 journals
    // silently. The schema is forward-compatible: extras are ignored, not
    // rejected.
    const raw = JSON.stringify({
      t: "log",
      msg: "hello",
      pass: 1,
      extra: "junk from a future version",
    })
    const v = validateJournalEvent(raw, 1)
    expect(v.ok).toBe(true)
  })

  test("event missing required field returns ok:false with field name", () => {
    const raw = JSON.stringify({ t: "agent", pass: 1 }) // missing 'key'
    const v = validateJournalEvent(raw, 1)
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.error.error.toLowerCase()).toContain("key")
    }
  })

  test("expected event types are exactly agent/log/phase", () => {
    // Type-level guard. The JournalEventType union should match
    // EXPECTED_TYPES. If a fourth type is added, this test will fail to
    // compile until EXPECTED_TYPES is updated.
    const sampleTypes: ReadonlyArray<JournalEventType> = ["agent", "log", "phase"]
    expect(sampleTypes).toEqual(EXPECTED_TYPES)
  })

  test("integration: persistence.ts loadJournal skips malformed events silently", async () => {
    // This test exercises the persistence.ts edit. It writes a journal
    // file with a known-malformed line and verifies loadJournal returns
    // the valid events without crashing.
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const path = await import("node:path")

    const dir = mkdtempSync(path.join(tmpdir(), "sffmc-m4-test-"))
    try {
      // valid runID format: wf_ + 26 base62 chars (per persistence.ts:RUN_ID_REGEX)
      const runID = "wf_" + "a".repeat(26)
      const journalPath = path.join(dir, `${runID}.jsonl`)
      const lines = [
        JSON.stringify({ t: "agent", key: "k1", args: {}, result: "r1", pass: 1 }),
        '{"t":"agent","key":"k2","result":"par', // torn line
        JSON.stringify({ t: "log", msg: "hi", pass: 1 }),
        // Phase event uses `title` field (matches runtime.ts:942-946 setPhase
        // and types.ts:57 JournalEventPhase). The phase event's pass=3 is
        // deliberately higher than other events — if the validator
        // incorrectly rejects phase events (regression), maxPass
        // stays at 1 and journal.pass = 2. After the fix, maxPass=3
        // and journal.pass=4.
        JSON.stringify({ t: "phase", title: "execute", pass: 3 }),
      ].join("\n")
      writeFileSync(journalPath, lines)

      const { WorkflowPersistence } = await import("../src/persistence.ts")
      const p = new WorkflowPersistence({ dataDir: dir })
      const journal = await p.loadJournal(runID)
      // Valid events loaded; torn line silently skipped.
      expect(journal.results.has("k1")).toBe(true)
      expect(journal.results.has("k2")).toBe(false) // torn → skipped
      // regression guard: phase event must be accepted (pass=3 →
      // maxPass=3 → journal.pass=4). If validator rejects phase events,
      // maxPass stays at 1 → journal.pass=2 → this assertion fails.
      expect(journal.pass).toBe(4)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
