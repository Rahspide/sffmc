// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Audit: clearJournal previously truncated to 0 bytes. A child
// workflow that called appendJournalSync within the 50ms fsync coalesce
// window would land a raw event as the first line of the file, which
// loadJournal would then treat as a torn header and silently skip.
// Fix: clearJournal now writes the v1 header `{"v":1}\n` so the file is
// always in a valid state for the next append.

import { describe, test, expect, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync, readFileSync } from "node:fs"
import path from "node:path"

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-workflow-journal-race-"))
process.env.XDG_DATA_HOME = tmpDir

import {
  WorkflowPersistence,
  computeScriptSha,
  flushJournalSync,
} from "../src/persistence.ts"

const p = new WorkflowPersistence({ dataDir: tmpDir })

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function makeRun(label: string): string {
  const sha = computeScriptSha(label)
  return p.createRun(`${label}.ts`, label, sha)
}

function readRawJournalLines(runID: string): string[] {
  return readFileSync(path.join(tmpDir, `${runID}.jsonl`), "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
}

describe("persistence.clearJournal v1-header preservation", () => {
  test("clearJournal writes v1 header as first line (1)", async () => {
    const runID = makeRun("clr-v1hdr")
    await p.clearJournal(runID)
    const lines = readRawJournalLines(runID)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toEqual({ v: 1 })
  })

  test("clearJournal followed by appendJournalSync preserves the event (2)", async () => {
    const runID = makeRun("clr-then-append")
    await p.clearJournal(runID)
    // Synchronous append — exactly the race the audit flagged: a child
    // workflow writing within 50ms of clearJournal.
    p.appendJournalSync(runID, { t: "agent", key: "k", result: "after-clear", pass: 1 })
    flushJournalSync()

    const lines = readRawJournalLines(runID)
    // Must be header + event, in that order. Before the fix this was either
    // 0 lines (file looked empty to loadJournal) or 1 line of raw event data
    // treated as a torn header and skipped.
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0])).toEqual({ v: 1 })
    expect(JSON.parse(lines[1])).toEqual({
      t: "agent", key: "k", result: "after-clear", pass: 1,
    })

    // loadJournal must surface the event, not silently drop it.
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(2) // maxPass(1) + 1
    expect(results.get("k")).toBe("after-clear")
  })

  test("clearJournal followed by multiple appends yields a valid journal (3)", async () => {
    const runID = makeRun("clr-multi-append")
    await p.clearJournal(runID)

    const N = 5
    for (let i = 1; i <= N; i++) {
      p.appendJournalSync(runID, {
        t: "agent", key: `k${i}`, result: `r${i}`, pass: i,
      })
    }
    flushJournalSync()

    const lines = readRawJournalLines(runID)
    expect(lines.length).toBe(N + 1) // 1 header + 5 events

    // First line must be v1 header
    expect(JSON.parse(lines[0])).toEqual({ v: 1 })

    // Remaining N lines must be the events in order
    for (let i = 0; i < N; i++) {
      expect(JSON.parse(lines[i + 1])).toEqual({
        t: "agent", key: `k${i + 1}`, result: `r${i + 1}`, pass: i + 1,
      })
    }

    // Exactly one header line, no duplicates
    const headerCount = lines.filter((l) => {
      try {
        const j = JSON.parse(l)
        return typeof j.v === "number" && !("t" in j)
      } catch {
        return false
      }
    }).length
    expect(headerCount).toBe(1)

    // loadJournal must surface all 5 events
    const { results, pass } = await p.loadJournal(runID)
    expect(pass).toBe(N + 1)
    expect(results.size).toBe(N)
    for (let i = 1; i <= N; i++) {
      expect(results.get(`k${i}`)).toBe(`r${i}`)
    }
  })

  test("clearJournal on nonexistent runID creates an empty journal with header (4)", async () => {
    // Sanity: clearJournal must be safe to call when no journal exists yet.
    const runID = makeRun("clr-fresh")
    // Confirm file does not exist yet
    let exists = true
    try {
      readFileSync(path.join(tmpDir, `${runID}.jsonl`), "utf-8")
    } catch {
      exists = false
    }
    expect(exists).toBe(false)

    await p.clearJournal(runID)
    const lines = readRawJournalLines(runID)
    expect(lines.length).toBe(1)
    expect(JSON.parse(lines[0])).toEqual({ v: 1 })

    // And a subsequent append must work, not get treated as a duplicate header
    p.appendJournalSync(runID, { t: "log", msg: "after-fresh-clear", pass: 1 })
    flushJournalSync()
    const lines2 = readRawJournalLines(runID)
    expect(lines2.length).toBe(2)
    expect(JSON.parse(lines2[0])).toEqual({ v: 1 })
    expect(JSON.parse(lines2[1])).toEqual({ t: "log", msg: "after-fresh-clear", pass: 1 })
  })
})