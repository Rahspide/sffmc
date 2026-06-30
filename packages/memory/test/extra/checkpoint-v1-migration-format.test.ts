// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint-v1-migration-format.test.ts
//
// Edge-case probes for v1 → v2 migration when the on-disk v1 file has
// format anomalies. These tests exercise the public surface of
// checkpoint.ts (readToolCalls, which triggers auto-migration
// internally) against adversarial inputs and verify that the
// migration path stays crash-free, loop-free, and degrades gracefully
// when the input is malformed. All tests carry a 5 s timeout — the
// goal is "fail or pass cleanly", never hang.
//
// v0.14.9 API note: `migrateV1ToV2` is no longer exported (it became
// a module-internal helper). Auto-migration happens automatically
// inside `readToolCalls` when it reads a v1 file; the on-disk file is
// rewritten to v2 in place and the parsed tool calls are returned.
//
// Header shape used to verify on-disk state after a migration — v2
// adds `lineOffsets` and `fileCrc32` (not present in v1).

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
  return mkdtempSync(join(tmpdir(), "sffmc-cp1fmt-"));
}

/** Build a well-formed v1-format header line (one JSON object, trailing LF). */
function makeV1Header(sessionID: string): string {
  return (
    JSON.stringify({
      __type: "header",
      sessionID,
      version: 1,
      createdAt: 1700000000000,
      updatedAt: 1700000000000,
    }) + "\n"
  );
}

/** Build a well-formed v1-format body line (one ToolCall, no trailing LF). */
function makeV1BodyLine(tool: string, callID: string, ts = 1700000000000): string {
  return JSON.stringify({
    tool,
    args: { command: tool },
    result: "ok",
    timestamp: ts,
    callID,
  });
}

/** Header shape for v2-format checkpoints — mirrors the on-disk shape
 *  of `CheckpointHeaderV2` in checkpoint.ts and is used to assert
 *  post-migration on-disk state. */
interface V2HeaderShape {
  __type: "header";
  sessionID: string;
  version: 2;
  createdAt: number;
  updatedAt: number;
  lineOffsets: number[];
  fileCrc32: number;
}

/** Read the first line of a checkpoint file and parse it as a header.
 *  Mirrors the helper in checkpoint-v2.test.ts — used to inspect the
 *  on-disk shape (version, lineOffsets, fileCrc32) that `readHeader`
 *  used to surface but is no longer exported. */
function readHeaderFromDisk(
  sessionID: string,
  dir: string,
): Record<string, unknown> | null {
  const fp = filePath(sessionID, dir);
  if (!existsSync(fp)) return null;
  const buf = readFileSync(fp, "utf-8");
  const firstLine = buf.split("\n")[0]?.trim();
  if (!firstLine) return null;
  try {
    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed.__type !== "header") return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("v1 migration: file format anomalies", () => {
  let dir: string;
  const sessionID = "fmt-anomaly";

  beforeEach(() => {
    dir = tmpCheckpointDir();
    __setCheckpointDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Empty file (zero bytes)
  // -----------------------------------------------------------------------

  describe("empty file (zero bytes)", () => {
    test("readToolCalls returns [] gracefully (no throw, no hang)", () => {
      writeFileSync(filePath(sessionID, dir), "", "utf-8");
      expect(existsSync(filePath(sessionID, dir))).toBe(true);

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      expect(readToolCalls(sessionID, dir)).toEqual([]);
    }, 5000);

    test("readToolCalls on an empty file leaves disk untouched (no .v1.bak, no v2 write)", () => {
      writeFileSync(filePath(sessionID, dir), "", "utf-8");

      // Empty file: readToolCalls early-returns [] at the fileBuf.length
      // === 0 check. No auto-migration is attempted; disk stays untouched.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // File must still be untouched (empty, not rewritten as v2).
      expect(readFileSync(filePath(sessionID, dir), "utf-8")).toBe("");
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 2. Truncated v1 file (header present, body missing)
  // -----------------------------------------------------------------------

  describe("truncated v1 file (header only, no body)", () => {
    test("readToolCalls returns [] (header is skipped, no body lines)", () => {
      writeFileSync(filePath(sessionID, dir), makeV1Header(sessionID), "utf-8");

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      expect(readToolCalls(sessionID, dir)).toEqual([]);
    }, 5000);

    test("readToolCalls auto-migrates to a valid v2 header-only file, v1 backup preserved", () => {
      writeFileSync(filePath(sessionID, dir), makeV1Header(sessionID), "utf-8");

      // v0.14.9: readToolCalls sees version=1, triggers auto-migration.
      // The v1 body is empty (no body lines after the header), so the
      // resulting v2 file has 0 tool calls. readToolCalls returns []
      // after rewriting the file to v2.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // v1 backup preserved (migration always backs up before rewriting).
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);

      // On-disk file is now v2 with an empty lineOffsets array.
      const onDisk = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(onDisk).not.toBeNull();
      expect(onDisk.version).toBe(2);
      expect(onDisk.sessionID).toBe(sessionID);
      expect(Array.isArray(onDisk.lineOffsets)).toBe(true);
      expect(onDisk.lineOffsets.length).toBe(0);
      expect(typeof onDisk.fileCrc32).toBe("number");
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 3. Corrupted JSON in v1 body line
  // -----------------------------------------------------------------------

  describe("corrupted JSON in v1 body line", () => {
    test("readToolCalls skips the bad line and returns only the good one", () => {
      const good = makeV1BodyLine("bash", "c-good");
      const corrupt = "{not valid json at all}";
      const content = makeV1Header(sessionID) + good + "\n" + corrupt + "\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("c-good");
    }, 5000);

    test("readToolCalls auto-migrates, preserving the good line and dropping the bad one", () => {
      const good = makeV1BodyLine("bash", "c-good");
      const corrupt = "{not valid json at all}";
      const content = makeV1Header(sessionID) + good + "\n" + corrupt + "\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      // readToolCalls triggers auto-migration: the v1 full-scan path
      // skips malformed lines, so only the "c-good" call survives the
      // rewrite. The file is now v2 with 1 line and the readToolCalls
      // return value is the surviving call.
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(1);
      expect(calls[0].callID).toBe("c-good");

      // On-disk state: v2 with 1 line offset.
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);
      expect(header.lineOffsets.length).toBe(1);

      // Backup exists.
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 4. UTF-8 BOM before v1 header
  // -----------------------------------------------------------------------

  describe("UTF-8 BOM before v1 header", () => {
    test("readToolCalls returns [] — JSON.parse on BOM-prefixed header fails", () => {
      // v0.14.9 NOTE: In the previous split-API design, `readHeader`
      // trimmed the BOM via `.trim()` (so it could parse), but
      // `readToolCalls` did NOT trim before JSON.parse. With auto-
      // migration, `readToolCalls` is the entry point — it reads raw
      // bytes, finds the first LF, and JSON.parses the slice that
      // includes the BOM. JSON.parse fails on BOM → readToolCalls
      // returns [] and NO migration is attempted.
      //
      // The body line is "invisible" to readToolCalls because the
      // BOM-prefixed header fails to parse first.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const headerJson = Buffer.from(makeV1Header(sessionID), "utf-8");
      const body = Buffer.from(
        makeV1BodyLine("bash", "bom-1") + "\n",
        "utf-8",
      );
      writeFileSync(filePath(sessionID, dir), Buffer.concat([bom, headerJson, body]));

      // Sanity: the file actually starts with a BOM.
      const onDisk = readFileSync(filePath(sessionID, dir));
      expect(onDisk[0]).toBe(0xef);
      expect(onDisk[1]).toBe(0xbb);
      expect(onDisk[2]).toBe(0xbf);

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      // BOM-prefixed header fails to parse → readToolCalls returns [].
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);
    }, 5000);

    test("BOM-prefixed file is left untouched on disk — no migration attempted, no .v1.bak created", () => {
      // v0.14.9 behavior: because readToolCalls is the entry point and
      // its JSON.parse fails on the BOM, no auto-migration is ever
      // attempted. The file stays as-is (BOM-prefixed v1, on disk)
      // and no .v1.bak backup is created. The data is therefore NOT
      // recoverable via the public API — the BOM prevents parsing.
      // (The previous split-API design recovered the data into a v2
      // file via readHeader.trim(); that path is no longer reachable.)
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const headerJson = Buffer.from(makeV1Header(sessionID), "utf-8");
      const body = Buffer.from(
        makeV1BodyLine("bash", "bom-1") + "\n",
        "utf-8",
      );
      writeFileSync(filePath(sessionID, dir), Buffer.concat([bom, headerJson, body]));

      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);

      // The on-disk file is byte-for-byte unchanged (still BOM-prefixed).
      const onDiskBuf = readFileSync(filePath(sessionID, dir));
      expect(onDiskBuf[0]).toBe(0xef);
      expect(onDiskBuf[1]).toBe(0xbb);
      expect(onDiskBuf[2]).toBe(0xbf);
      expect(onDiskBuf.toString("utf-8")).toContain('"callID":"bom-1"');

      // No .v1.bak was created — migration was never attempted.
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 5. CRLF line endings in v1 body
  // -----------------------------------------------------------------------

  describe("CRLF line endings in v1 body", () => {
    test("readToolCalls recovers all three calls (v1 path trims CR before parse)", () => {
      const headerLine = makeV1Header(sessionID).trimEnd(); // strip the LF
      const lines = [
        makeV1BodyLine("bash", "cr-1", 1700000000000),
        makeV1BodyLine("read", "cr-2", 1700000001000),
        makeV1BodyLine("edit", "cr-3", 1700000002000),
      ];
      const content = headerLine + "\r\n" + lines.join("\r\n") + "\r\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      // Sanity: the file actually uses CRLF.
      const onDisk = readFileSync(filePath(sessionID, dir), "utf-8");
      expect(onDisk).toContain("\r\n");

      expect(() => readToolCalls(sessionID, dir)).not.toThrow();
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(3);
      expect(calls.map((c) => c.callID)).toEqual(["cr-1", "cr-2", "cr-3"]);
      expect(calls.map((c) => c.tool)).toEqual(["bash", "read", "edit"]);
    }, 5000);

    test("readToolCalls auto-migrates with all 3 lines preserved end-to-end", () => {
      const headerLine = makeV1Header(sessionID).trimEnd();
      const lines = [
        makeV1BodyLine("bash", "cr-1", 1700000000000),
        makeV1BodyLine("read", "cr-2", 1700000001000),
        makeV1BodyLine("edit", "cr-3", 1700000002000),
      ];
      const content = headerLine + "\r\n" + lines.join("\r\n") + "\r\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      // Auto-migration triggers: v1 full-scan reads each line via
      // split('\n').trim() so CR-prefixed lines still parse. After
      // migration the file is rewritten with LF newlines.
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(3);
      expect(calls.map((c) => c.callID)).toEqual(["cr-1", "cr-2", "cr-3"]);
      expect(calls.map((c) => c.tool)).toEqual(["bash", "read", "edit"]);

      // v1 backup retained (contains CRLF bytes verbatim).
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
      expect(readFileSync(join(dir, `${sessionID}.jsonl.v1.bak`), "utf-8")).toContain("\r\n");

      // The post-migration file is valid v2 (newlines are LF, not CRLF).
      const v2Buf = readFileSync(filePath(sessionID, dir));
      const v2Lines = v2Buf.toString("utf-8").trim().split("\n");
      expect(v2Lines.length).toBe(4); // header + 3 body lines
      const v2Header = JSON.parse(v2Lines[0]!) as Record<string, unknown>;
      expect(v2Header.version).toBe(2);
      expect(Array.isArray(v2Header.lineOffsets)).toBe(true);
      expect((v2Header.lineOffsets as unknown[]).length).toBe(3);
    }, 5000);
  });
});