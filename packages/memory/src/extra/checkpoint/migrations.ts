// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// v1 → v2 migration (public API).
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// Policy (v0.14.9): v1 files are auto-migrated to v2 in place on the
// first read via `readHeader` / `readToolCalls`. Callers do not need to
// invoke this migration API directly. The on-disk format remains v2;
// this module is retained for internal callers that need the structured
// MigrationResult (e.g. telemetry) and for the regression test suite.

import { defaultFsOps, type FsOps } from "@sffmc/utilities";

import { DEFAULT_MAX_CHECKPOINT_FILE_SIZE } from "./constants.js";
import { readHeader } from "./header.js";
import { filePath } from "./paths.js";
import { readToolCallsShim } from "./reader.js";
import type { MigrationResult, ToolCall } from "./types.js";

/** Internal: trigger auto-migration (via `readHeader`) and return the
 *  structured result. With auto-migration on read, this is effectively
 *  a "force-migrate and return MigrationResult" wrapper.
 *
 *  Behavior:
 *  - File missing → `{ ok: false, error: "checkpoint not found", ... }`
 *  - Already v2 → no-op, returns `{ ok: true, sourceVersion: 2, lines }`
 *  - v1 → triggers auto-migration inside `readHeader`, returns
 *    `{ ok: true, sourceVersion: 1, lines }` once the file is rewritten
 *  - Any other failure → `{ ok: false, error }`
 *
 *  No longer exported via the public package — callers should rely on
 *  auto-migration. Kept here for internal callers that need the
 *  structured MigrationResult.
 *
 *  Accepts an optional `fs` injection; defaults to `defaultFsOps`. */
export function migrateV1ToV2(
  sessionID: string,
  dir?: string,
  fs: FsOps = defaultFsOps,
): MigrationResult {
  const fp = filePath(sessionID, dir);

  const fail = (sourceVersion: 1 | 2, lines: number, error: string): MigrationResult => ({
    ok: false,
    sourceVersion,
    targetVersion: 2,
    lines,
    error,
  });

  if (!fs.exists(fp)) {
    return fail(1, 0, "checkpoint not found");
  }

  // Detect the original version BEFORE calling readHeader (which
  // auto-migrates v1 → v2 in place). This is a cheap raw read and
  // lets us report the correct `sourceVersion` in the result.
  let originalVersion: 1 | 2 = 1;
  try {
    const raw = fs.readFile(fp);
    const firstLine = raw.split("\n")[0]?.trim();
    if (firstLine) {
      const parsed = JSON.parse(firstLine) as Record<string, unknown>;
      if (parsed.version === 2) originalVersion = 2;
    }
  } catch {
    // Treat as v1 if unreadable.
  }

  // Trigger auto-migration by calling readHeader (returns null if
  // migration failed or the file is not a valid checkpoint).
  let header: ReturnType<typeof readHeader>;
  try {
    header = readHeader(sessionID, dir, DEFAULT_MAX_CHECKPOINT_FILE_SIZE, fs);
  } catch (e) {
    return fail(originalVersion, 0, e instanceof Error ? e.message : String(e));
  }
  if (!header) {
    return fail(originalVersion, 0, "checkpoint not found");
  }

  let calls: ToolCall[];
  try {
    calls = readToolCallsShim(sessionID, dir, DEFAULT_MAX_CHECKPOINT_FILE_SIZE, fs);
  } catch (e) {
    return fail(originalVersion, 0, e instanceof Error ? e.message : String(e));
  }

  if (originalVersion === 2) {
    return {
      ok: true,
      sourceVersion: 2,
      targetVersion: 2,
      lines: calls.length,
    };
  }

  return {
    ok: true,
    sourceVersion: 1,
    targetVersion: 2,
    lines: calls.length,
  };
}