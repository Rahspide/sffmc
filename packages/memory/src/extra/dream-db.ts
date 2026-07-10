// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream DB helpers
// Pure DB/archive file helpers extracted from dream.ts (M-3 Wave 1).
// All functions take a `FsOps` parameter (default `defaultFsOps`) so
// tests can inject `createMockFsOps()` for hermetic runs without the
// real filesystem.

import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { defaultFsOps, redactSecrets, type FsOps } from "@sffmc/utilities";
import { DREAM_SNIPPET_LENGTH, type MemoryRow } from "./dream-types.ts";

export function openDB(dbPath: string, fs: FsOps = defaultFsOps): Database {
  // Ensure the directory exists
  const dir = dirname(dbPath);
  if (!fs.exists(dir)) {
    fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  return db;
}

export function ensureArchiveDir(
  archivePath: string,
  fs: FsOps = defaultFsOps,
): void {
  const dir = dirname(archivePath);
  if (!fs.exists(dir)) {
    fs.mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export function archiveEntry(
  entry: MemoryRow,
  archivePath: string,
  fs: FsOps = defaultFsOps,
): void {
  ensureArchiveDir(archivePath, fs);
  // Redact content before writing to the dream archive. The archive
  // is on-disk JSONL; if a memory row embedded a raw credential, the
  // archive would persist it forever. `redactSecrets` returns the redacted
  // text plus categories + count for forensic visibility.
  const redaction = redactSecrets(entry.content);
  const record = buildArchiveRecord(entry, redaction);
  fs.appendFile(archivePath, JSON.stringify(record) + "\n");
}

/** Build the JSONL record object for an archived entry: the 7 original
 *  MemoryRow fields + redaction metadata (count + categories) + 2 audit
 *  timestamps (ms + ISO). The redaction result is passed in by the
 *  caller so the actual write can stay in archiveEntry. Pure data builder —
 *  no filesystem I/O — kept separate so the orchestration
 *  (ensure dir → redact → build → append) reads top-down at the call site
 *  and the record shape can be pinned by tests via the existing #15
 *  JSONL round-trip test. */
export function buildArchiveRecord(
  entry: MemoryRow,
  redaction: { redacted: string; count: number; categories: string[] },
): Record<string, unknown> {
  // `archived_at_ms` is consumed by downstream forensic tooling that
  // expects a millisecond epoch timestamp (matching `Date.now()` shape).
  // We keep the direct `Date.now()` call here because the value isn't
  // consumed by any time-arithmetic logic in the data plane — tests
  // assert presence/recency via range checks, not exact pins.
  return {
    id: entry.id,
    source_path: entry.source_path,
    section: entry.section,
    content: redaction.redacted,
    redaction_count: redaction.count,
    redaction_categories: redaction.categories,
    importance_score: entry.importance_score,
    last_accessed: entry.last_accessed,
    created_at: entry.created_at,
    archived_at_ms: Date.now(),
    archived_at_iso: new Date().toISOString(),
  };
}

/** Fallback summarization: concatenate  `snippetLength` chars of each entry.
 *   LOW migration: `snippetLength` is now configurable via
 *  `DreamConfig.snippetLength`; defaults to `DREAM_SNIPPET_LENGTH` (100). */
export function concatenateSummary(
  entries: MemoryRow[],
  snippetLength: number = DREAM_SNIPPET_LENGTH,
): string {
  const snippets = entries.map((e) => {
    const text = e.content.substring(0, snippetLength);
    const ellipsis = e.content.length > snippetLength ? "…" : "";
    return `[${e.source_path}] ${text}${ellipsis}`;
  });
  return `DREAM-SUMMARY (${entries.length} entries merged):\n${snippets.join("\n")}`;
}