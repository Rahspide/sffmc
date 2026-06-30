// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Read tool calls / list sessions / delete checkpoint files.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).

import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createLogger } from "@sffmc/shared";

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
 *  definition still present during the incremental extraction phase. */
export function readToolCallsShim(
  sessionID: string,
  dir?: string,
  maxFileSize: number = DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
): ToolCall[] {
  const fp = filePath(sessionID, dir);

  // Stat-based size check before loading into memory.
  try {
    const st = statSync(fp);
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

  let fileBuf: Buffer;
  try {
    fileBuf = readFileSync(fp);
  } catch {
    return [];
  }

  // buf.length is the file size — cheap early-exit on empty files
  // (equivalent to what a stat() pre-check would have given us).
  if (fileBuf.length === 0) return [];

  // Read the header line to detect the on-disk version. v1 files are
  // auto-migrated to v2 in place on first read; after migration the
  // v2 indexed-seek path runs as if the file had always been v2.
  const firstNewline = fileBuf.indexOf(0x0a);
  if (firstNewline < 0) return [];
  const headerLine = fileBuf.subarray(0, firstNewline).toString("utf-8");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(headerLine) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (parsed.__type !== "header") return [];

  // v1 → auto-migrate to v2 in place, then re-read the file buffer
  // (the rewrite changes byte offsets, so we cannot reuse `fileBuf`).
  if (parsed.version === 1) {
    const header = readHeader(sessionID, dir, maxFileSize);
    if (!header) {
      log.warn(
        `checkpoint: readToolCalls auto-migrate v1→v2 failed for ${sessionID}`,
      );
      return [];
    }
    try {
      fileBuf = readFileSync(fp);
    } catch {
      return [];
    }
    const firstNewline2 = fileBuf.indexOf(0x0a);
    if (firstNewline2 < 0) return [];
    const headerLine2 = fileBuf.subarray(0, firstNewline2).toString("utf-8");
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
  const lineOffsets = parsed.lineOffsets;
  if (!Array.isArray(lineOffsets)) return [];

  return iterateBodyLines(fileBuf, lineOffsets);
}

/** List all checkpoint session IDs (file basenames without `.jsonl`)
 *  in the given directory. Missing directory → empty list. */
export function listSessions(dir?: string): string[] {
  const d = dir ?? getCheckpointDir();
  if (!existsSync(d)) return [];

  try {
    const files = readdirSync(d);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

/** Delete the on-disk checkpoint file for `sessionID`. Returns
 *  `true` if a file was removed, `false` if the file was missing or
 *  could not be unlinked (e.g. permission denied). */
export function deleteCheckpoint(sessionID: string, dir?: string): boolean {
  const fp = filePath(sessionID, dir);
  if (!existsSync(fp)) return false;
  try {
    unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}