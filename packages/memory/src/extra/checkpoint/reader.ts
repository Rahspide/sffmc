// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Read tool calls / list sessions / delete checkpoint files.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).

import { createLogger, defaultFsOps, type FsOps } from "@sffmc/shared";

import { DEFAULT_MAX_CHECKPOINT_FILE_SIZE } from "./constants.js";
import { readHeader } from "./header.js";
import { iterateBodyLines } from "./lines.js";
import { filePath, getCheckpointDir } from "./paths.js";
import { CheckpointTooLargeError } from "./types.js";
import type { ToolCall } from "./types.js";

const log = createLogger("extra-checkpoint");

/** Read all ToolCalls from an on-disk v2 checkpoint. Auto-migrates v1
 *  files in place on first read; on missing/oversize/malformed files
 *  returns an empty array or throws `CheckpointTooLargeError`.
 *
 *  Public API: previously `export function readToolCalls` in
 *  checkpoint.ts. The `_shim` suffix avoids collision with the in-file
 *  definition still present during the incremental extraction phase.
 *
 *  Accepts an optional `fs` injection for tests; defaults to `defaultFsOps`.
 *  Pass `createMockFsOps()` here to exercise the read path without disk. */
export function readToolCallsShim(
  sessionID: string,
  dir?: string,
  maxFileSize: number = DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
  fs: FsOps = defaultFsOps,
): ToolCall[] {
  const fp = filePath(sessionID, dir);

  // Stat-based size check before loading into memory.
  try {
    const st = fs.stat(fp);
    if (st.size > maxFileSize) {
      log.warn(
        `checkpoint: skipping ${sessionID} — file size ${(st.size / 1024 / 1024).toFixed(1)}MB exceeds limit (${maxFileSize / 1024 / 1024}MB)`,
      );
      // Oversize error: throw a typed error so callers can distinguish
      // "oversize" from "missing file" (which still returns []).
      throw new CheckpointTooLargeError(sessionID, st.size, maxFileSize);
    }
  } catch (e) {
    if (e instanceof CheckpointTooLargeError) throw e;
    return [];
  }

  let fileContent: string;
  try {
    fileContent = fs.readFile(fp);
  } catch {
    return [];
  }

  // content.length is the file size in chars — cheap early-exit on empty
  // files (equivalent to what a stat() pre-check would have given us for
  // ASCII content). For multi-byte UTF-8 the size in `stat` is byte-count
  // and the byte-vs-char delta matters only for the empty check, which is
  // safe regardless.
  if (fileContent.length === 0) return [];

  // Read the header line to detect the on-disk version. v1 files are
  // auto-migrated to v2 in place on first read; after migration the
  // v2 indexed-seek path runs as if the file had always been v2.
  const firstNewline = fileContent.indexOf("\n");
  if (firstNewline < 0) return [];
  const headerLine = fileContent.substring(0, firstNewline);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(headerLine) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (parsed.__type !== "header") return [];

  // v1 → auto-migrate to v2 in place, then re-read the file content
  // (the rewrite changes byte offsets, so we cannot reuse the buffer).
  if (parsed.version === 1) {
    const header = readHeader(sessionID, dir, maxFileSize, fs);
    if (!header) {
      log.warn(
        `checkpoint: readToolCalls auto-migrate v1→v2 failed for ${sessionID}`,
      );
      return [];
    }
    try {
      fileContent = fs.readFile(fp);
    } catch {
      return [];
    }
    const firstNewline2 = fileContent.indexOf("\n");
    if (firstNewline2 < 0) return [];
    const headerLine2 = fileContent.substring(0, firstNewline2);
    try {
      parsed = JSON.parse(headerLine2) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (parsed.__type !== "header" || parsed.version !== 2) return [];
  } else if (parsed.version !== 2) {
    return [];
  }

  // v2 path: seek to each recorded offset and parse the line.
  // For the in-memory fs the offsets are char-based (UTF-16 code units),
  // which is equivalent to byte offsets for ASCII content (the on-disk
  // encoding uses UTF-8 with no multi-byte chars in checkpoint payloads).
  const lineOffsets = parsed.lineOffsets as number[];
  if (!Array.isArray(lineOffsets)) return [];

  return iterateBodyLinesFromString(fileContent, lineOffsets);
}

/** Sibling of `lines.ts#iterateBodyLines` that takes the full file as a
 *  string instead of a Buffer. Same skip semantics: out-of-range offsets,
 *  duplicate header lines (`__type === "header"`), and lines whose JSON
 *  doesn't match the ToolCall shape are all silently skipped.
 *
 *  On ASCII content the byte-offset and char-offset coincide; checkpoint
 *  payloads are JSON-serialized ASCII so the equivalence is exact. */
function iterateBodyLinesFromString(content: string, lineOffsets: number[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; i < lineOffsets.length; i++) {
    const start = lineOffsets[i];
    if (typeof start !== "number" || start < 0 || start >= content.length) continue;
    const lineEnd = content.indexOf("\n", start);
    const line = lineEnd >= 0 ? content.substring(start, lineEnd) : content.substring(start);
    if (!line) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (obj.__type === "header") continue;
      if (
        typeof obj.tool === "string" &&
        typeof obj.timestamp === "number" &&
        typeof obj.callID === "string"
      ) {
        calls.push(obj as unknown as ToolCall);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return calls;
}

/** List all checkpoint session IDs (file basenames without `.jsonl`)
 *  in the given directory. Missing directory → empty list.
 *
 *  Accepts an optional `fs` injection; defaults to `defaultFsOps`. */
export function listSessions(dir?: string, fs: FsOps = defaultFsOps): string[] {
  const d = dir ?? getCheckpointDir();
  if (!fs.exists(d)) return [];

  try {
    const files = fs.readDir(d);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/** Delete the on-disk checkpoint file for `sessionID`. Returns
 *  `true` if a file was removed, `false` if the file was missing or
 *  could not be unlinked (e.g. permission denied).
 *
 *  Accepts an optional `fs` injection; defaults to `defaultFsOps`. */
export function deleteCheckpoint(
  sessionID: string,
  dir?: string,
  fs: FsOps = defaultFsOps,
): boolean {
  const fp = filePath(sessionID, dir);
  if (!fs.exists(fp)) return false;
  try {
    fs.unlink(fp);
    return true;
  } catch {
    return false;
  }
}