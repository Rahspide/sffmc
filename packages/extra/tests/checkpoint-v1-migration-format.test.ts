// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint-v1-migration-format.test.ts
//
// Edge-case probes for v1 → v2 migration when the on-disk v1 file has
// format anomalies. These tests exercise the public surface of
// checkpoint.ts (readToolCalls / migrateV1ToV2) against adversarial
// inputs and verify that the migration path stays crash-free,
// loop-free, and degrades gracefully when the input is malformed.
// All tests carry a 5 s timeout — the goal is "fail or pass cleanly",
// never hang.
//
// Note: `readHeader` is internal (not exported); the equivalent public
// probes are `readToolCalls` (reads body via the v1 full-scan path)
// and `migrateV1ToV2` (the explicit user-callable migration entry
// point, which internally calls readHeader + readToolCalls).
//
// Important: the side-effecting `migrateV1ToV2` is called exactly ONCE
// per test — re-invoking it against a now-v2 file would return the
// no-op idempotent result instead of the v1→v2 migration result.

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
  migrateV1ToV2,
} from "../src/checkpoint";

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

    test("migrateV1ToV2 reports 'checkpoint not found' without touching disk", () => {
      writeFileSync(filePath(sessionID, dir), "", "utf-8");

      let result: ReturnType<typeof migrateV1ToV2> | null = null;
      expect(() => {
        result = migrateV1ToV2(sessionID, dir);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(false);
      expect(result!.error).toBe("checkpoint not found");
      expect(result!.sourceVersion).toBe(1);
      expect(result!.targetVersion).toBe(2);
      expect(result!.lines).toBe(0);

      // The file must be untouched and no .v1.bak created.
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

    test("migrateV1ToV2 succeeds with lines=0, produces a valid v2 header-only file", () => {
      writeFileSync(filePath(sessionID, dir), makeV1Header(sessionID), "utf-8");

      let result: ReturnType<typeof migrateV1ToV2> | null = null;
      expect(() => {
        result = migrateV1ToV2(sessionID, dir);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(result!.sourceVersion).toBe(1);
      expect(result!.targetVersion).toBe(2);
      expect(result!.lines).toBe(0);

      // v1 backup preserved.
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);

      // On-disk file is now v2 with an empty lineOffsets array.
      const onDisk = readFileSync(filePath(sessionID, dir), "utf-8");
      const headerLine = onDisk.split("\n")[0]!;
      const onDiskHeader = JSON.parse(headerLine) as Record<string, unknown>;
      expect(onDiskHeader.version).toBe(2);
      expect(onDiskHeader.sessionID).toBe(sessionID);
      expect(Array.isArray(onDiskHeader.lineOffsets)).toBe(true);
      expect((onDiskHeader.lineOffsets as unknown[]).length).toBe(0);
      expect(typeof onDiskHeader.fileCrc32).toBe("number");
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

    test("migrateV1ToV2 preserves the good line, drops the bad one, no crash", () => {
      const good = makeV1BodyLine("bash", "c-good");
      const corrupt = "{not valid json at all}";
      const content = makeV1Header(sessionID) + good + "\n" + corrupt + "\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      let result: ReturnType<typeof migrateV1ToV2> | null = null;
      expect(() => {
        result = migrateV1ToV2(sessionID, dir);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(result!.sourceVersion).toBe(1);
      expect(result!.lines).toBe(1);

      // Post-migration read should return only the good line.
      const after = readToolCalls(sessionID, dir);
      expect(after.length).toBe(1);
      expect(after[0].callID).toBe("c-good");
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // 4. UTF-8 BOM before v1 header
  // -----------------------------------------------------------------------

  describe("UTF-8 BOM before v1 header", () => {
    test("readToolCalls returns [] — header JSON.parse fails on BOM (readHeader trims, readToolCalls does not)", () => {
      // POTENTIAL BUG (documented): `readHeader` strips leading
      // whitespace (including the UTF-8 BOM) via `.trim()` before
      // JSON.parse, but `readToolCalls` passes the raw header bytes
      // to JSON.parse without trimming. As a result, a BOM-prefixed
      // header is "seen" by `readHeader` but "invisible" to
      // `readToolCalls`. The behavior mismatch means a BOM-prefixed
      // checkpoint looks like an empty file to readToolCalls.
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
      // Documented actual behavior: BOM-prefixed header fails to parse
      // → readToolCalls returns [] despite the file having 1 body line.
      const calls = readToolCalls(sessionID, dir);
      expect(calls).toEqual([]);
    }, 5000);

    test("migrateV1ToV2 succeeds with lines=0 — readHeader trims BOM and parses, but readToolCalls reports 0 body lines; v1 backup retains the data", () => {
      // Documents the same BOM-induced mismatch in the migration path:
      // readHeader's .trim() lets the header parse succeed, but
      // readToolCalls returns 0 calls, so the migration writes a v2
      // file with zero body lines. The data is NOT lost from disk —
      // the .v1.bak retains the BOM-prefixed original byte-for-byte —
      // but the migrated v2 file is empty.
      const bom = Buffer.from([0xef, 0xbb, 0xbf]);
      const headerJson = Buffer.from(makeV1Header(sessionID), "utf-8");
      const body = Buffer.from(
        makeV1BodyLine("bash", "bom-1") + "\n",
        "utf-8",
      );
      writeFileSync(filePath(sessionID, dir), Buffer.concat([bom, headerJson, body]));

      let result: ReturnType<typeof migrateV1ToV2> | null = null;
      expect(() => {
        result = migrateV1ToV2(sessionID, dir);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(result!.sourceVersion).toBe(1);
      expect(result!.targetVersion).toBe(2);
      // Documented actual behavior: migration reports lines=0 even
      // though the v1 file has 1 call. The v2 file is therefore empty.
      expect(result!.lines).toBe(0);

      // The v1 backup must contain the BOM-prefixed bytes verbatim
      // (backup is byte-for-byte copy via copyFileSync, no trim) — so
      // the data CAN be recovered manually if needed.
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
      const bakBuf = readFileSync(join(dir, `${sessionID}.jsonl.v1.bak`));
      expect(bakBuf[0]).toBe(0xef);
      expect(bakBuf[1]).toBe(0xbb);
      expect(bakBuf[2]).toBe(0xbf);
      expect(bakBuf.toString("utf-8")).toContain('"callID":"bom-1"');

      // Post-migration file is BOM-free but has zero body lines.
      const v2Buf = readFileSync(filePath(sessionID, dir));
      expect(v2Buf[0]).not.toBe(0xef);
      const v2Lines = v2Buf.toString("utf-8").trim().split("\n");
      expect(v2Lines.length).toBe(1); // header only, no body lines
      const v2Header = JSON.parse(v2Lines[0]!) as Record<string, unknown>;
      expect(v2Header.version).toBe(2);
      expect((v2Header.lineOffsets as unknown[]).length).toBe(0);
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

    test("migrateV1ToV2 succeeds with all 3 lines preserved end-to-end", () => {
      const headerLine = makeV1Header(sessionID).trimEnd();
      const lines = [
        makeV1BodyLine("bash", "cr-1", 1700000000000),
        makeV1BodyLine("read", "cr-2", 1700000001000),
        makeV1BodyLine("edit", "cr-3", 1700000002000),
      ];
      const content = headerLine + "\r\n" + lines.join("\r\n") + "\r\n";
      writeFileSync(filePath(sessionID, dir), content, "utf-8");

      let result: ReturnType<typeof migrateV1ToV2> | null = null;
      expect(() => {
        result = migrateV1ToV2(sessionID, dir);
      }).not.toThrow();
      expect(result).not.toBeNull();
      expect(result!.ok).toBe(true);
      expect(result!.sourceVersion).toBe(1);
      expect(result!.targetVersion).toBe(2);
      expect(result!.lines).toBe(3);

      // v1 backup retained (contains CRLF bytes verbatim).
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
      expect(readFileSync(join(dir, `${sessionID}.jsonl.v1.bak`), "utf-8")).toContain("\r\n");

      // Post-migration: all three calls round-trip cleanly.
      const after = readToolCalls(sessionID, dir);
      expect(after.length).toBe(3);
      expect(after.map((c) => c.callID)).toEqual(["cr-1", "cr-2", "cr-3"]);
      expect(after.map((c) => c.tool)).toEqual(["bash", "read", "edit"]);

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