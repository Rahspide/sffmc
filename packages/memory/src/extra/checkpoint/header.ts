// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Header build/read/write — v2 schema (the only supported schema;
// v1 files are auto-migrated on first read by `migrations.ts`).
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// Header schema (v2):
//   __type:       "header"
//   sessionID:    string
//   version:      2
//   createdAt:    number (epoch ms)
//   updatedAt:    number (epoch ms)
//   lineOffsets:  number[] — byte offset of each body line from file start
//   fileCrc32:    number  — CRC32 of all body bytes (joined + trailing \n)

import { join } from "node:path";
import { createLogger, defaultFsOps, type FsOps } from "@sffmc/utilities";

import { crc32 } from "./crc";
import { DEFAULT_MAX_CHECKPOINT_FILE_SIZE } from "./constants";
import { ensureDir, filePath, getCheckpointDir } from "./paths";
import { CheckpointTooLargeError } from "./types";
import type { ToolCall } from "./types";

const log = createLogger("extra-checkpoint");

/** v2 header schema. Adds `lineOffsets` (byte offset of each body line
 *  from start of file) and `fileCrc32` (CRC32 of all body bytes). */
export interface CheckpointHeaderV2 {
  __type: "header";
  sessionID: string;
  version: 2;
  createdAt: number;
  updatedAt: number;
  lineOffsets: number[];
  fileCrc32: number;
}

/** The only supported header schema. v1 files are auto-migrated to v2
 *  on first read (transparent to callers). */
export type CheckpointHeader = CheckpointHeaderV2;

/** Build a v2 header object with stable field order so that
 *  `JSON.stringify` produces a deterministic byte sequence (matters for
 *  the offset-iteration convergence). */
export function makeV2Header(
  sessionID: string,
  lineOffsets: number[],
  fileCrc32: number,
  createdAt: number,
  updatedAt: number,
): Record<string, unknown> {
  return {
    __type: "header",
    sessionID,
    version: 2,
    createdAt,
    updatedAt,
    lineOffsets,
    fileCrc32,
  };
}

/** Serialize a v2 body line (one ToolCall) with stable key order
 *  `tool, args, result, timestamp, callID, __crc`. The per-line CRC is
 *  computed over the JSON WITHOUT `__crc`, then `__crc` is appended. */
export function buildV2BodyLine(tc: ToolCall): string {
  const lineNoCrc = JSON.stringify({
    tool: tc.tool,
    args: tc.args,
    result: tc.result,
    timestamp: tc.timestamp,
    callID: tc.callID,
  });
  const crc = crc32(lineNoCrc);
  return JSON.stringify({
    tool: tc.tool,
    args: tc.args,
    result: tc.result,
    timestamp: tc.timestamp,
    callID: tc.callID,
    __crc: crc,
  });
}

/** Build the v2 body bytes and per-line byte lengths from a list of
 *  ToolCalls. The returned `bodyConcat` is the on-disk body (lines
 *  joined by "\n", trailing "\n" included); `bodyBytes` is the UTF-8
 *  encoding used to compute the file-level CRC32; `bodyLineBytes` is
 *  the per-line byte length consumed by the offset-iteration loop. */
export function buildV2Body(calls: ToolCall[]): {
  bodyConcat: string;
  bodyBytes: Uint8Array;
  bodyLineBytes: number[];
} {
  const lines: string[] = [];
  const lineBytes: number[] = [];
  for (const tc of calls) {
    const line = buildV2BodyLine(tc);
    lines.push(line);
    lineBytes.push(Buffer.byteLength(line, "utf-8"));
  }
  const bodyConcat = lines.join("\n") + "\n";
  const bodyBytes = new TextEncoder().encode(bodyConcat);
  return { bodyConcat, bodyBytes, bodyLineBytes: lineBytes };
}

/** Compute the final v2 header string with converged line offsets.
 *  The header size depends on the offsets it contains (digit counts
 *  grow with offset values), so we iterate to a fixed point — typically
 *  ≤3 iterations for realistic session sizes. The caller MUST hold
 *  `updatedAt` constant across the call so that the returned header
 *  string and its serialized offsets agree byte-for-byte. */
export function computeV2HeaderStr(
  sessionID: string,
  bodyLineBytes: number[],
  fileCrc32: number,
  createdAt: number,
  updatedAt: number,
): string {
  let offsets: number[] = [];
  for (let iter = 0; iter < 10; iter++) {
    const headerStr =
      JSON.stringify(makeV2Header(sessionID, offsets, fileCrc32, createdAt, updatedAt)) + "\n";
    const headerLen = Buffer.byteLength(headerStr, "utf-8");

    const newOffsets: number[] = [];
    let p = headerLen;
    for (let i = 0; i < bodyLineBytes.length; i++) {
      newOffsets.push(p);
      p += bodyLineBytes[i] + 1; // +1 for "\n"
    }

    if (
      newOffsets.length === offsets.length &&
      newOffsets.every((v, i) => v === offsets[i])
    ) {
      return headerStr;
    }
    offsets = newOffsets;
  }
  // Fallback after the iteration cap: build the header from the last
  // (not-yet-converged) offsets. In practice the loop converges within
  // ≤3 iterations for any realistic session size.
  return JSON.stringify(makeV2Header(sessionID, offsets, fileCrc32, createdAt, updatedAt)) + "\n";
}

/** Write a placeholder v2 header to disk. Final values (lineOffsets,
 *  fileCrc32) are computed and rewritten by `_flushSession` after the
 *  body lines are appended so the offsets reflect the actual byte
 *  layout. */
export function writeHeader(
  sessionID: string,
  dir?: string,
  fs: FsOps = defaultFsOps,
): void {
  const fp = filePath(sessionID, dir);
  const d = dir ?? getCheckpointDir();
  ensureDir(d, fs);

  const now = Date.now();
  const header = makeV2Header(sessionID, [], 0, now, now);
  fs.appendFile(fp, JSON.stringify(header) + "\n");
}

/** Read + parse the on-disk v2 header. Returns `null` for missing,
 *  malformed, or non-v2 files. Throws `CheckpointTooLargeError` when
 *  the file exceeds `maxFileSize` so callers can distinguish "oversize"
 *  from "missing".
 *
 *  Triggers auto-migration on v1 files (writes v2 in place, then re-reads).
 *  Migration failures return `null` (the caller treats them as "no header").
 *
 *  Accepts an optional `fs` injection for tests; defaults to `defaultFsOps`.
 *  Pass `createMockFsOps()` here to exercise the read path without
 *  touching disk. */
export function readHeader(
  sessionID: string,
  dir?: string,
  maxFileSize: number = DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
  fs: FsOps = defaultFsOps,
): CheckpointHeader | null {
  const fp = filePath(sessionID, dir);

  try {
    const st = fs.stat(fp);
    if (st.size > maxFileSize) {
      log.warn(
        `checkpoint: skipping ${sessionID} — file size ${(st.size / 1024 / 1024).toFixed(1)}MB exceeds limit (${maxFileSize / 1024 / 1024}MB)`,
      );
      // Oversize error: throw a typed error so callers can distinguish
      // "oversize" from "missing file" (which still returns null).
      throw new CheckpointTooLargeError(sessionID, st.size, maxFileSize);
    }
  } catch (e) {
    if (e instanceof CheckpointTooLargeError) throw e;
    return null;
  }

  // First-line read + JSON parse. On any failure (empty file, missing
  // file caught above, malformed first line, non-header first line),
  // treat as "no header" and return null.
  let firstLine: string | undefined;
  try {
    const raw = fs.readFile(fp);
    firstLine = raw.split("\n")[0]?.trim();
  } catch (e) {
    log.warn({ err: e, sessionID }, "checkpoint-header: readFile failed");
    return null;
  }
  if (!firstLine) return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(firstLine) as Record<string, unknown>;
  } catch (e) {
    log.warn({ err: e, sessionID }, "checkpoint-header: parse failed");
    return null;
  }
  if (parsed.__type !== "header") return null;

  // v1 → auto-migrate to v2 in place, then fall through to the v2
  // read path. After migration, `parsed` is re-read from disk.
  if (parsed.version === 1) {
    const mig = migrateV1ToV2InPlace(sessionID, dir, fs);
    if (!mig.ok) {
      log.warn(
        `checkpoint: auto-migrate v1→v2 failed for ${sessionID}: ${mig.error ?? "unknown error"}`,
      );
      return null;
    }
    try {
      const raw = fs.readFile(fp);
      firstLine = raw.split("\n")[0]?.trim();
    } catch (e) {
      log.warn({ err: e, sessionID }, "checkpoint-header: post-migrate readFile failed");
      return null;
    }
    if (!firstLine) return null;
    try {
      parsed = JSON.parse(firstLine) as Record<string, unknown>;
    } catch (e) {
      log.warn({ err: e, sessionID }, "checkpoint-header: post-migrate parse failed");
      return null;
    }
    if (parsed.__type !== "header" || parsed.version !== 2) return null;
  } else if (parsed.version !== 2) {
    return null;
  }

  // v2: validate the index/CRC fields are present.
  if (
    !Array.isArray(parsed.lineOffsets) ||
    typeof parsed.fileCrc32 !== "number"
  ) {
    return null;
  }
  return parsed as unknown as CheckpointHeaderV2;
}

// ---------------------------------------------------------------------------
// Internal — v1 in-place migration helper used by `readHeader` to upgrade
// the on-disk file before re-reading. Defined here (rather than in
// migrations.ts) to keep the migration path co-located with the header
// reader; this is the only call site.
// ---------------------------------------------------------------------------

/** Internal: v1 → v2 in-place migration. Reads the v1 file body via
 *  full-scan, builds a v2 file (per-line CRC + offsets + file CRC),
 *  backs up the original to `<sessionID>.jsonl.v1.bak`, and rewrites
 *  the file as v2.
 *
 *  Does NOT call `readHeader` or `readToolCalls` — that would recurse
 *  through the auto-migration hooks. Operates on raw bytes instead.
 *
 *  Returns `{ ok, lines }`; `ok=false` includes `error`. No-op (and
 *  `ok=true`) when the file is already v2. */
function migrateV1ToV2InPlace(
  sessionID: string,
  dir?: string,
  fs: FsOps = defaultFsOps,
): { ok: boolean; lines: number; error?: string } {
  const d = dir ?? getCheckpointDir();
  const fp = filePath(sessionID, dir);

  if (!fs.exists(fp)) {
    return { ok: false, lines: 0, error: "checkpoint not found" };
  }

  let raw: string;
  try {
    raw = fs.readFile(fp);
  } catch (e) {
    return { ok: false, lines: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const firstLine = raw.split("\n")[0]?.trim();
  if (!firstLine) {
    return { ok: false, lines: 0, error: "empty file" };
  }

  let parsedHeader: Record<string, unknown>;
  try {
    parsedHeader = JSON.parse(firstLine) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, lines: 0, error: e instanceof Error ? e.message : String(e) };
  }
  if (parsedHeader.__type !== "header") {
    return { ok: false, lines: 0, error: "not a checkpoint file" };
  }

  // Already v2 — no migration needed; count existing lines for the
  // `lines` field so callers can report progress.
  if (parsedHeader.version === 2) {
    return { ok: true, lines: readV1BodyLines(raw).length };
  }

  if (parsedHeader.version !== 1) {
    return {
      ok: false,
      lines: 0,
      error: `unknown checkpoint version: ${parsedHeader.version as number}`,
    };
  }

  const createdAt =
    typeof parsedHeader.createdAt === "number" ? parsedHeader.createdAt : Date.now();

  // Read v1 body via full-scan.
  const calls = readV1BodyLines(raw);

  // Backup v1 file before rewriting. Failure aborts the migration —
  // we never destroy data without a safety copy.
  const backupPath = join(d, `${sessionID}.jsonl.v1.bak`);
  try {
    fs.copyFile(fp, backupPath);
  } catch (e) {
    return {
      ok: false,
      lines: calls.length,
      error: `backup failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Build v2 file. The header size depends on the offsets it contains
  // (digit counts grow with offset values), so we iterate to a fixed
  // point — typically ≤3 iterations for typical session sizes.
  // `updatedAt` is captured once and held constant across the
  // iteration so the returned header string and its serialized
  // offsets agree byte-for-byte.
  const { bodyConcat, bodyBytes, bodyLineBytes } = buildV2Body(calls);
  const fileCrc = crc32(bodyBytes);
  const finalHeaderStr = computeV2HeaderStr(
    sessionID,
    bodyLineBytes,
    fileCrc,
    createdAt,
    Date.now(),
  );

  try {
    fs.writeFile(fp, finalHeaderStr + bodyConcat);
  } catch (e) {
    return {
      ok: false,
      lines: calls.length,
      error: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { ok: true, lines: calls.length };
}

/** Internal: extract tool calls from a v1 file body via full-scan.
 *  Skips the header line (anything with `__type === "header"`). The
 *  same field-shape rules as `readToolCalls`: keep only lines that
 *  parse as objects with `tool` (string), `timestamp` (number), and
 *  `callID` (string). Used by the auto-migration path. */
function readV1BodyLines(raw: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.__type === "header") continue;
      if (
        typeof obj.tool === "string" &&
        typeof obj.timestamp === "number" &&
        typeof obj.callID === "string"
      ) {
        calls.push(obj as unknown as ToolCall);
      }
    } catch (e) {
      log.debug({ err: e, lineIndex: i }, "checkpoint-header: skipping malformed line");
    }
  }
  return calls;
}