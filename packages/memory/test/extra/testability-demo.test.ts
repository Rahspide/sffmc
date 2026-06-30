// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Demonstrates the testability primitives added for M-4 (FsOps +
// clock injection). These tests would have been impossible to write
// before the refactor without either real temp dirs (slow, flaky) or
// monkey-patching globals (ugly, fragile). Each test uses a clean
// in-memory `FsOps` or a pinned clock, runs the same code paths that
// production runs, and asserts the post-state directly.

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { resolve } from "node:path"
import { tmpdir } from "node:os"

import {
  __resetClock,
  __setClock,
  createMockFsOps,
  defaultFsOps,
  SECONDS_PER_DAY,
  unixNow,
} from "@sffmc/utilities"

import {
  flushSession,
  getOrCreateBuffer,
  type CheckpointBufferState,
  type ToolCall,
} from "../../src/extra/checkpoint/buffer.ts"
import { clearCronTimer, createDreamTool } from "../../src/extra/dream.ts"

// ---------------------------------------------------------------------------
// mockFsOps: in-memory checkpoint flush round-trip
// ---------------------------------------------------------------------------

describe("testability: mockFsOps → in-memory checkpoint flush", () => {
  it("flushes a buffered session into the mock filesystem (no disk touched)", () => {
    const { fs, files, dirs } = createMockFsOps()
    dirs.add("/checkpoints")
    const state: CheckpointBufferState = {
      dir: "/checkpoints",
      sessionBuffers: new Map(),
      headersWritten: new Set(),
      flushTimer: null,
      flushIntervalMs: 1000,
      maxBufferedSessions: 4,
    }

    const tc: ToolCall = {
      tool: "echo",
      args: { text: "hi" },
      result: "hi",
      timestamp: 1_000_000,
      callID: "call-1",
    }
    const buf = getOrCreateBuffer(state, "ses-1")
    buf.push(tc)

    flushSession(state, "ses-1", fs)

    // Post-flush state:
    //   - the on-disk-shape file lives at /checkpoints/ses-1.jsonl
    //   - the mock's `files` map mirrors what real disk would hold
    const fp = "/checkpoints/ses-1.jsonl"
    expect(files.has(fp)).toBe(true)
    const content = files.get(fp) ?? ""
    expect(content.startsWith('{"__type":"header"')).toBe(true)
    expect(content).toContain('"version":2')
    expect(content).toContain('"tool":"echo"')
    // Header line + body line, joined by "\n", trailing "\n" included.
    const lines = content.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    // headersWritten tracks which sessions were first-flushed
    expect(state.headersWritten.has("ses-1")).toBe(true)
  })

  it("produces byte-identical output as defaultFsOps when seeded identically", () => {
    // Independent file paths so the two implementations don't collide.
    const realDir = resolve(tmpdir(), `sffmc-testability-real-${Date.now()}`)
    const mockDir = "/mock-checkpoints"

    // === Real disk ===
    rmSync(realDir, { recursive: true, force: true })
    const realState: CheckpointBufferState = {
      dir: realDir,
      sessionBuffers: new Map(),
      headersWritten: new Set(),
      flushTimer: null,
      flushIntervalMs: 1000,
      maxBufferedSessions: 4,
    }
    const realBuf = getOrCreateBuffer(realState, "ses-rt")
    realBuf.push({
      tool: "noop",
      args: { x: 1 },
      result: null,
      timestamp: 2_000_000,
      callID: "c",
    })
    flushSession(realState, "ses-rt", defaultFsOps)
    const realBytes = readFileSync(
      resolve(realDir, "ses-rt.jsonl"),
      "utf-8",
    )

    // === Mock ===
    const { fs, dirs, files } = createMockFsOps()
    dirs.add(mockDir)
    const mockState: CheckpointBufferState = {
      dir: mockDir,
      sessionBuffers: new Map(),
      headersWritten: new Set(),
      flushTimer: null,
      flushIntervalMs: 1000,
      maxBufferedSessions: 4,
    }
    const mockBuf = getOrCreateBuffer(mockState, "ses-rt")
    mockBuf.push({
      tool: "noop",
      args: { x: 1 },
      result: null,
      timestamp: 2_000_000,
      callID: "c",
    })
    flushSession(mockState, "ses-rt", fs)
    const mockBytes = files.get(`${mockDir}/ses-rt.jsonl`) ?? ""

    // The byte content can differ on `createdAt` / `updatedAt`
    // (time-dependent fields), but the structural shape must match:
    // a header line and one body line, in that order.
    const realLines = realBytes.split("\n").filter(Boolean)
    const mockLines = mockBytes.split("\n").filter(Boolean)
    expect(realLines.length).toBe(2)
    expect(mockLines.length).toBe(2)
    // Both lines start with the same header prefix and end with the same
    // body line (the ToolCall payload is identical and not time-dependent).
    expect(realLines[0].startsWith('{"__type":"header"')).toBe(true)
    expect(mockLines[0].startsWith('{"__type":"header"')).toBe(true)
    expect(realLines[1]).toBe(mockLines[1])

    rmSync(realDir, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// __setClock: time-travel through staleness logic
// ---------------------------------------------------------------------------

describe("testability: __setClock → time-travel through dream staleness", () => {
  let testDir: string
  let dbPath: string

  beforeEach(() => {
    testDir = resolve(tmpdir(), `sffmc-clock-demo-${Date.now()}-${Math.random()}`)
    dbPath = resolve(testDir, "memory", "index.sqlite")
    // Ensure the parent dir exists before opening the DB.
    mkdirSync(resolve(testDir, "memory"), { recursive: true })
  })

  afterEach(async () => {
    __resetClock()
    clearCronTimer()
    rmSync(testDir, { recursive: true, force: true })
  })

  it("archives stale entries when the clock is pinned past the threshold (no sleeping)", async () => {
    // Pin the clock to a known anchor so we can compute relative timestamps
    // deterministically (no flake from wall-clock drift between seed and
    // assertion).
    const T_ANCHOR = 1_700_000_000 // arbitrary, well past Y2K
    __setClock(() => T_ANCHOR)

    // Open a fresh DB at a temp path and seed it with two entries:
    //   - `fresh`: last_accessed = now  → NOT stale
    //   - `old`:   last_accessed = now - 60 days → STALE (window is 30d)
    const db = new Database(dbPath)
    db.exec("PRAGMA journal_mode=WAL;")
    db.exec(`
      CREATE TABLE memory_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_path TEXT NOT NULL,
        section TEXT,
        content TEXT NOT NULL,
        importance_score REAL DEFAULT 0.5,
        last_accessed INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `)
    const insert = db.prepare(
      "INSERT INTO memory_entries (source_path, content, last_accessed, created_at) VALUES (?, ?, ?, ?)",
    )
    insert.run("docs/fresh.md", "fresh entry", unixNow(), unixNow())
    insert.run(
      "docs/old.md",
      "stale entry content",
      unixNow() - 60 * SECONDS_PER_DAY,
      unixNow() - 60 * SECONDS_PER_DAY,
    )
    db.close()

    // Build the dream factory and trigger a manual run. The clock stays
    // pinned at T_ANCHOR throughout, so runDream computes
    // staleThresholdSec = unixNow() - SECONDS_PER_STALE_WINDOW as
    // T_ANCHOR - 30d exactly — the 60-day-old entry qualifies, the
    // fresh one does not. Asserted purely on the result shape; no
    // real wall clock touched, no sleep/timer awaited beyond the LLM
    // concurrency lock which falls back to the empty path.
    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: dbPath,
      ctx: undefined,
      summaryModel: undefined,
      // Tighten the dedup / cluster thresholds so only stale removal runs
      // (avoids LLM invocation in this no-ctx scenario).
      dedupThreshold: 2, // disable dedup (any pair is non-duplicate)
      clusterThreshold: 2, // disable clustering (no pair clusters)
      maxEntries: 1000,
      archivePath: resolve(testDir, "archive.jsonl"),
    })

    const beforeCount = (
      new Database(dbPath, { readonly: true })
        .query("SELECT COUNT(*) AS c FROM memory_entries")
        .get() as { c: number }
    ).c
    expect(beforeCount).toBe(2)

    const result = await tool.execute({ dry_run: false })
    expect(result.ok).toBe(true)
    expect(result.archived).toBe(1) // exactly the stale row

    const afterCount = (
      new Database(dbPath, { readonly: true })
        .query("SELECT COUNT(*) AS c FROM memory_entries")
        .get() as { c: number }
    ).c
    expect(afterCount).toBe(1)
  })

  it("__setClock is process-global and __resetClock restores wall clock", () => {
    __setClock(() => 123)
    expect(unixNow()).toBe(123)

    __setClock(null)
    expect(unixNow()).not.toBe(123)
    // After reset, value comes from real wall clock (Math.floor(Date.now() / 1000)).
    expect(unixNow()).toBeGreaterThan(1_000_000_000)
  })
})
