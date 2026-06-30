// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint-v1-migration-read-errors.test.ts
//
// Edge-case probes for v1 → v2 auto-migration when the on-disk v1 file's
// HEADER is anomalous — specifically: missing required fields
// (`__type`, `sessionID`) and out-of-range or non-integer `version`
// values. The companion files (checkpoint-v1-migration-format.test.ts
// for format-level anomalies; checkpoint-v1-migration-scale.test.ts for
// scale/iteration convergence) cover different axes; this file focuses
// on the v0.14.9 header-validation path.
//
// Goal: confirm that the read + migrate pipeline stays crash-free,
// loop-free, and degrades gracefully when the header is malformed.
// Every test carries a 5 s timeout — the goal is "fail or pass
// cleanly", never hang.
//
// v0.14.9 API note: `migrateV1ToV2` is no longer exported. All probes
// use `readToolCalls`, which triggers auto-migration internally when
// the file is detected as v1. The implementation's header-validation
// logic (which gates migration on `__type === "header"` and `version`
// being exactly 1) sits inside the same code path.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __setCheckpointDir,
  filePath,
  readToolCalls,
} from "../src/extra/checkpoint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpCheckpointDir(): string {
  return mkdtempSync(join(tmpdir(), "sffmc-cp1re-"));
}

/** Build a well-formed v1 body line (one ToolCall, no trailing LF).
 *  Used to give the malformed-header tests a realistic body so we can
 *  distinguish "migration succeeded silently" from "migration was
 *  rejected because there's nothing to migrate". */
function makeV1BodyLine(tool: string, callID: string, ts = 1700000000000): string {
  return JSON.stringify({
    tool,
    args: { command: tool },
    result: "ok",
    timestamp: ts,
    callID,
  });
}

/** Write a v1-format checkpoint file with a CUSTOM header object
 *  (allowing missing fields, anomalous versions, etc.) plus an
 *  optional list of body lines. Returns the file path. */
function writeCustomHeaderV1(
  sessionID: string,
  headerObj: Record<string, unknown>,
  bodyLines: string[] = [],
  dir: string,
): string {
  const fp = filePath(sessionID, dir);
  const headerStr = JSON.stringify(headerObj);
  const body = bodyLines.length > 0 ? "\n" + bodyLines.join("\n") + "\n" : "";
  writeFileSync(fp, headerStr + body, "utf-8");
  return fp;
}

/** Read the first line of a checkpoint file and parse it as a header.
 *  Mirrors the helper used in checkpoint-v2.test.ts — used here to
 *  verify the on-disk file is UNCHANGED after a failed migration
 *  attempt. */
function readFirstLineHeader(
  sessionID: string,
  dir: string,
): Record<string, unknown> | null {
  const fp = filePath(sessionID, dir);
  if (!existsSync(fp)) return null;
  const buf = readFileSync(fp, "utf-8");
  const firstLine = buf.split("\n")[0]?.trim();
  if (!firstLine) return null;
  try {
    return JSON.parse(firstLine) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("v1 auto-migration: read errors + version anomalies", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpCheckpointDir();
    __setCheckpointDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Missing __type field in v1 header
  // -----------------------------------------------------------------------

  describe("missing __type field in v1 header", () => {
    test("readToolCalls returns [] — the header is rejected before migration is attempted", () => {
      const sessionID = "missing-type";
      const body = [makeV1BodyLine("bash", "c-1")];
      // Header has version: 1 and sessionID, but no __type marker.
      writeCustomHeaderV1(
        sessionID,
        {
          // __type: "header"  <-- intentionally omitted
          sessionID,
          version: 1,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        body,
        dir,
      );

      // readToolCalls's first check is `parsed.__type !== "header"` →
      // early-returns []. Auto-migration is never triggered. No
      // .v1.bak is created and the file is untouched.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // The on-disk file MUST be unchanged — no silent migration to v2,
      // no .v1.bak created (backup step is gated behind a successful
      // header parse).
      const header = readFirstLineHeader(sessionID, dir);
      expect(header).not.toBeNull();
      expect(header!.__type).toBeUndefined();
      expect(header!.version).toBe(1);
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);

    test("readToolCalls does not throw on the malformed header (returns [])", () => {
      const sessionID = "missing-type-rt";
      writeCustomHeaderV1(
        sessionID,
        { sessionID, version: 1, createdAt: 1, updatedAt: 1 },
        [makeV1BodyLine("bash", "c-1")],
        dir,
      );

      // readToolCalls: parsed.__type !== "header" → returns []. The
      // body line is not reached because the early-return gates on the
      // header parse. No crash.
      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls).toEqual([]);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 2. version: 0
  // -----------------------------------------------------------------------

  describe("version: 0 (below supported range)", () => {
    test("readToolCalls returns [] — version 0 is not migrated (strict-equality check)", () => {
      const sessionID = "version-zero";
      const body = [makeV1BodyLine("bash", "v0-1")];
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: 0,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        body,
        dir,
      );

      // readToolCalls sees __type === "header" but version === 0 (not
      // 1, not 2) → falls into the `else if (parsed.version !== 2)`
      // branch and returns []. No migration is attempted.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // File MUST be untouched on disk.
      const header = readFirstLineHeader(sessionID, dir);
      expect(header).not.toBeNull();
      expect(header!.version).toBe(0);
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);

    test("readToolCalls does not throw and returns [] on version 0", () => {
      const sessionID = "version-zero-rt";
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        [makeV1BodyLine("bash", "v0-1")],
        dir,
      );

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls).toEqual([]);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 3. version: -1
  // -----------------------------------------------------------------------

  describe("version: -1 (negative, below supported range)", () => {
    test("readToolCalls returns [] — negative version is not migrated", () => {
      const sessionID = "version-neg";
      const body = [makeV1BodyLine("bash", "vn-1")];
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: -1,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        body,
        dir,
      );

      // Same gating as version: 0 — version === -1 (not 1, not 2) →
      // returns [] without migration. File untouched.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // File untouched.
      const header = readFirstLineHeader(sessionID, dir);
      expect(header).not.toBeNull();
      expect(header!.version).toBe(-1);
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);

    test("readToolCalls does not throw and returns [] on version -1", () => {
      const sessionID = "version-neg-rt";
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: -1,
          createdAt: 1,
          updatedAt: 1,
        },
        [makeV1BodyLine("bash", "vn-1")],
        dir,
      );

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls).toEqual([]);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 4. version: 1.5 (non-integer)
  // -----------------------------------------------------------------------

  describe("version: 1.5 (non-integer)", () => {
    test("readToolCalls returns [] — strict-equality rejects 1.5 as a version", () => {
      const sessionID = "version-frac";
      const body = [makeV1BodyLine("bash", "vf-1")];
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: 1.5,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        body,
        dir,
      );

      // 1.5 === 1 is false, 1.5 === 2 is false → falls into the
      // `else if (parsed.version !== 2)` branch and returns [].
      // Strict-equality gating, no coercion.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // File MUST be untouched on disk — no silent migration.
      const header = readFirstLineHeader(sessionID, dir);
      expect(header).not.toBeNull();
      expect(header!.version).toBe(1.5);
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);

    test("readToolCalls does not throw on the fractional version (returns [])", () => {
      const sessionID = "version-frac-rt";
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          sessionID,
          version: 1.5,
          createdAt: 1,
          updatedAt: 1,
        },
        [makeV1BodyLine("bash", "vf-1")],
        dir,
      );

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls).toEqual([]);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 5. Missing sessionID field in v1 header
  // -----------------------------------------------------------------------

  describe("missing sessionID field in v1 header", () => {
    test("readToolCalls triggers auto-migration; missing header sessionID is silently replaced with the parameter sessionID (documented gap)", () => {
      // v0.14.9 BEHAVIOR GAP (documented):
      // The implementation does NOT validate that the v1 header
      // carries a `sessionID` string. `__migrateV1ToV2InPlace` reads
      // the header as a Record<string, unknown> and falls back to
      // `Date.now()` for `createdAt` if missing — but for `sessionID`
      // it uses the parameter passed by the caller as a fallback
      // (the v2 header is rebuilt using the caller's sessionID).
      //
      // This means a malformed v1 file with no `sessionID` field is
      // silently migrated to v2 using the caller's sessionID — the
      // header's missing field is replaced, not rejected. A future
      // fix should reject this case with a graceful error; the test
      // below documents the current behavior so a regression to
      // "graceful error" can be detected and tightened.
      const sessionID = "missing-sessionid";
      const body = [makeV1BodyLine("bash", "ms-1")];
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          // sessionID omitted
          version: 1,
          createdAt: 1700000000000,
          updatedAt: 1700000000000,
        },
        body,
        dir,
      );

      // Pre-migration: header on disk has no sessionID.
      const before = readFirstLineHeader(sessionID, dir);
      expect(before).not.toBeNull();
      expect(before!.__type).toBe("header");
      expect(before!.version).toBe(1);
      expect(before!.sessionID).toBeUndefined();

      // readToolCalls triggers auto-migration: __type is "header" and
      // version is 1, so the migration path runs. The implementation
      // uses the parameter sessionID as a fallback for the missing
      // header field. The body line is preserved.
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("ms-1");

      // The on-disk file is now v2 (auto-migration succeeded silently).
      const after = readFirstLineHeader(sessionID, dir);
      expect(after).not.toBeNull();
      expect(after!.version).toBe(2);
      // The v2 header carries the caller's sessionID, not the
      // (missing) header one.
      expect(after!.sessionID).toBe(sessionID);

      // The .v1.bak exists (migration always backs up before rewriting).
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
    }, 5000);

    test("readToolCalls does not throw when the header has no sessionID", () => {
      const sessionID = "missing-sessionid-rt";
      writeCustomHeaderV1(
        sessionID,
        {
          __type: "header",
          version: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        [makeV1BodyLine("bash", "ms-1")],
        dir,
      );

      // readToolCalls uses the v1 full-scan path when the header
      // version is 1; it does not consult header.sessionID for line
      // selection. The body line is recoverable.
      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(Array.isArray(calls)).toBe(true);
      // The body line has tool/timestamp/callID, so it survives the
      // v1 full-scan filter regardless of the header's sessionID.
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("ms-1");
    }, 5000);
  });
});