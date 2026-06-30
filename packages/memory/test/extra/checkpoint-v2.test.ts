// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint-v2.test.ts
//
// Coverage for the v2 checkpoint format: indexed access (lineOffsets),
// per-line CRC32 (__crc), file-level CRC32 (fileCrc32), v1 backward
// compatibility, and the v1→v2 auto-migration that fires on read.
// See checkpoint.ts for the on-disk format and the v1→v2
// auto-migration behavior (readHeader / readToolCalls trigger
// `__migrateV1ToV2InPlace` on first read of a v1 file).

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
  crc32,
  CURRENT_VERSION,
  __setCheckpointDir,
  filePath,
  readToolCalls,
  createCheckpointTool,
} from "../src/extra/checkpoint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpCheckpointDir(): string {
  return mkdtempSync(join(tmpdir(), "sffmc-cpv2-"));
}

/** Build a v1-format checkpoint file (header version 1, body lines without
 *  __crc). Used by the backward-compat and migration tests. */
function writeV1File(
  sessionID: string,
  dir: string,
  calls: Array<{
    tool: string;
    args: unknown;
    result: unknown;
    timestamp: number;
    callID: string;
  }>,
): string {
  const fp = filePath(sessionID, dir);
  const header = JSON.stringify({
    __type: "header",
    sessionID,
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const body = calls.map((c) => JSON.stringify(c)).join("\n");
  writeFileSync(fp, header + "\n" + body + (body ? "\n" : ""), "utf-8");
  return fp;
}

/** Header shape for v2-format checkpoints — mirrors the on-disk shape of
 *  `CheckpointHeaderV2` in checkpoint.ts and is used for structural
 *  casts in the tests below. */
interface V2HeaderShape {
  __type: "header";
  sessionID: string;
  version: 2;
  createdAt: number;
  updatedAt: number;
  lineOffsets: number[];
  fileCrc32: number;
}

/** Read the first line of a checkpoint file and parse it as a header
 *  object. Returns `null` if the file does not exist or the first line
 *  is not a header. Used to inspect v2-specific fields (lineOffsets,
 *  fileCrc32) that are not surfaced through the public restore action.
 *  Mirrors the implementation's `readHeader` semantics for the test
 *  paths that need to assert on the on-disk shape. */
function readHeaderFromDisk(sessionID: string, dir: string): Record<string, unknown> | null {
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

describe("checkpoint v2", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpCheckpointDir();
    __setCheckpointDir(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // crc32 — IEEE 802.3 known-vector
  // -----------------------------------------------------------------------

  describe("crc32", () => {
    test("matches the IEEE 802.3 reference vector for '123456789'", () => {
      // CRC32 of the ASCII string "123456789" is the canonical reference
      // value used to verify any CRC32 implementation: 0xCBF43926.
      expect(crc32("123456789")).toBe(0xcbf43926);
    });

    test("returns the same value for equivalent string and Uint8Array inputs", () => {
      const bytes = new TextEncoder().encode("hello sffmc");
      expect(crc32("hello sffmc")).toBe(crc32(bytes));
    });
  });

  // -----------------------------------------------------------------------
  // CURRENT_VERSION — regression guard
  // -----------------------------------------------------------------------

  describe("CURRENT_VERSION", () => {
    test("equals 2 (regression guard)", () => {
      expect(CURRENT_VERSION).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // v1 backward compatibility
  // -----------------------------------------------------------------------

  describe("v1 backward compatibility", () => {
    test("reads v1-format files via readToolCalls (no __crc field in body lines)", () => {
      const sessionID = "v1-bc-1";
      writeV1File(sessionID, dir, [
        {
          tool: "bash",
          args: { command: "ls" },
          result: "a\nb\n",
          timestamp: 1700000000000,
          callID: "c-1",
        },
        {
          tool: "grep",
          args: { pattern: "TODO", path: "./src" },
          result: ["a.ts:1:TODO"],
          timestamp: 1700000001000,
          callID: "c-2",
        },
        {
          tool: "write",
          args: { path: "/tmp/out" },
          result: "ok",
          timestamp: 1700000002000,
          callID: "c-3",
        },
      ]);

      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(3);
      expect(calls[0].tool).toBe("bash");
      expect(calls[0].args).toEqual({ command: "ls" });
      expect(calls[0].callID).toBe("c-1");
      expect(calls[0].timestamp).toBe(1700000000000);
      expect(calls[1].tool).toBe("grep");
      expect(calls[1].args).toEqual({ pattern: "TODO", path: "./src" });
      expect(calls[2].tool).toBe("write");
      expect(calls[2].args).toEqual({ path: "/tmp/out" });
    });

    test("v1-typed header on disk has no lineOffsets/fileCrc32 fields", () => {
      const sessionID = "v1-bc-h";
      writeV1File(sessionID, dir, [
        {
          tool: "bash",
          args: {},
          result: "ok",
          timestamp: 1,
          callID: "x",
        },
      ]);

      const header = readHeaderFromDisk(sessionID, dir);
      expect(header).not.toBeNull();
      expect(header!.__type).toBe("header");
      expect(header!.version).toBe(1);
      expect(header!.sessionID).toBe(sessionID);
      // v1 has no index/CRC fields — readers must not assume them.
      expect(header!.lineOffsets).toBeUndefined();
      expect(header!.fileCrc32).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // v2 write + read (via the implementation's flush path)
  // -----------------------------------------------------------------------

  describe("v2 write+read", () => {
    test("writes a v2 header and three body lines, reads them back via readHeader + readToolCalls", async () => {
      const sessionID = "v2-wr-1";
      const cp = createCheckpointTool({ enabled: true });

      const calls: Array<{
        tool: string;
        args: unknown;
        result: unknown;
        callID: string;
      }> = [
        {
          tool: "bash",
          args: { command: "pwd" },
          result: "/tmp",
          callID: "wc-1",
        },
        {
          tool: "read",
          args: { path: "./README.md" },
          result: "hello",
          callID: "wc-2",
        },
        {
          tool: "edit",
          args: { path: "./x.ts", old: "a", new: "b" },
          result: "ok",
          callID: "wc-3",
        },
      ];

      for (const c of calls) {
        await cp.hooks["tool.execute.after"]!(
          { tool: c.tool, sessionID, callID: c.callID },
          { output: c.result, metadata: { args: c.args } },
        );
      }
      cp.flushSession(sessionID);

      const fp = filePath(sessionID, dir);
      expect(existsSync(fp)).toBe(true);

      // header round-trip
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);
      expect(header.sessionID).toBe(sessionID);
      expect(header.createdAt).toBeTypeOf("number");
      expect(Array.isArray(header.lineOffsets)).toBe(true);
      expect(header.fileCrc32).toBeTypeOf("number");

      // tool calls round-trip
      const read = readToolCalls(sessionID, dir);
      expect(read.length).toBe(3);
      expect(read[0].tool).toBe("bash");
      expect(read[0].args).toEqual({ command: "pwd" });
      expect(read[0].callID).toBe("wc-1");
      expect(read[1].tool).toBe("read");
      expect(read[1].callID).toBe("wc-2");
      expect(read[2].tool).toBe("edit");
      expect(read[2].callID).toBe("wc-3");

      // each body line carries an `__crc` number field (v2 schema)
      const buf = readFileSync(fp);
      const lines = buf.toString("utf-8").trim().split("\n");
      const bodyLines = lines.slice(1);
      expect(bodyLines.length).toBe(3);
      for (const line of bodyLines) {
        const obj = JSON.parse(line) as Record<string, unknown>;
        expect(typeof obj.__crc).toBe("number");
      }

      cp.cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // lineOffsets — accuracy
  // -----------------------------------------------------------------------

  describe("lineOffsets accuracy", () => {
    test("header.lineOffsets has one entry per body line, each pointing to '{' in the file", async () => {
      const sessionID = "v2-offsets";
      const N = 7;
      const cp = createCheckpointTool({ enabled: true });

      for (let i = 0; i < N; i++) {
        await cp.hooks["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID,
            callID: `off-${i}`,
          },
          {
            output: `r-${i}`,
            metadata: { args: { i } },
          },
        );
      }
      cp.flushSession(sessionID);

      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);

      const fileBuf = readFileSync(filePath(sessionID, dir));
      for (let i = 0; i < N; i++) {
        const off = header.lineOffsets[i];
        // Each offset must be inside the file and point at the opening
        // brace of a JSON body line.
        expect(off).toBeGreaterThanOrEqual(0);
        expect(off).toBeLessThan(fileBuf.length);
        expect(fileBuf[off]).toBe(0x7b); // "{"
      }

      cp.cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // fileCrc32 — matches manual CRC32 of body bytes
  // -----------------------------------------------------------------------

  describe("fileCrc32 verification", () => {
    test("header.fileCrc32 equals crc32() of the body bytes", async () => {
      const sessionID = "v2-crc";
      const cp = createCheckpointTool({ enabled: true });

      for (let i = 0; i < 4; i++) {
        await cp.hooks["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID,
            callID: `crc-${i}`,
          },
          {
            output: `output-${i}`,
            metadata: { args: { command: `echo ${i}` } },
          },
        );
      }
      cp.flushSession(sessionID);

      const fileBuf = readFileSync(filePath(sessionID, dir));
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();

      // Body bytes = everything after the header line (including the
      // trailing "\n" of the header line itself, so we slice from
      // headerEnd inclusive of the trailing newline).
      const headerEnd = fileBuf.indexOf(0x0a) + 1; // index just past the LF
      const bodyBytes = fileBuf.subarray(headerEnd);
      const expectedCrc = crc32(bodyBytes);
      expect(header.fileCrc32).toBe(expectedCrc);

      cp.cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Migration: v1 → v2
  // -----------------------------------------------------------------------

  describe("auto-migration v1 to v2", () => {
    test("readToolCalls auto-migrates a v1 file to v2 in place, backs up the v1, and preserves all lines", () => {
      const sessionID = "mig-v1-v2";
      const originalCalls = [
        {
          tool: "bash",
          args: { command: "ls -la" },
          result: "file1\nfile2\n",
          timestamp: 1700000000000,
          callID: "m-1",
        },
        {
          tool: "edit",
          args: { path: "./a.ts" },
          result: "ok",
          timestamp: 1700000001000,
          callID: "m-2",
        },
      ];
      writeV1File(sessionID, dir, originalCalls);

      const backupPath = join(dir, `${sessionID}.jsonl.v1.bak`);
      expect(existsSync(backupPath)).toBe(false);

      // Pre-read: file is still v1 on disk.
      const preHeader = readHeaderFromDisk(sessionID, dir);
      expect(preHeader).not.toBeNull();
      expect(preHeader!.version).toBe(1);

      // Public-API read triggers auto-migration in place.
      const read = readToolCalls(sessionID, dir);
      expect(read.length).toBe(2);
      expect(read[0].callID).toBe("m-1");
      expect(read[0].tool).toBe("bash");
      expect(read[0].args).toEqual({ command: "ls -la" });
      expect(read[1].callID).toBe("m-2");
      expect(read[1].tool).toBe("edit");

      // The v1 backup file must exist with the original bytes intact.
      expect(existsSync(backupPath)).toBe(true);
      const backupBuf = readFileSync(backupPath, "utf-8");
      expect(backupBuf).toContain('"version":1');
      // v1 body lines had no __crc; ensure the backup did not get
      // mutated by the migration.
      const backupLines = backupBuf.trim().split("\n");
      for (let i = 1; i < backupLines.length; i++) {
        const obj = JSON.parse(backupLines[i]) as Record<string, unknown>;
        expect(obj.__crc).toBeUndefined();
      }

      // The v2 file is now at <sessionID>.jsonl with a v2 header.
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);
      expect(Array.isArray(header.lineOffsets)).toBe(true);
      expect(typeof header.fileCrc32).toBe("number");

      // v2 body lines should each carry an `__crc` field.
      const v2Buf = readFileSync(filePath(sessionID, dir));
      const v2Lines = v2Buf.toString("utf-8").trim().split("\n");
      expect(v2Lines.length).toBe(3); // 1 header + 2 calls
      for (let i = 1; i < v2Lines.length; i++) {
        const obj = JSON.parse(v2Lines[i]) as Record<string, unknown>;
        expect(typeof obj.__crc).toBe("number");
      }
    });

    test("readToolCalls returns [] when the checkpoint file is missing (no migration possible)", () => {
      const result = readToolCalls("does-not-exist", dir);
      expect(result).toEqual([]);
      // No backup file should have been created on the not-found path.
      expect(existsSync(join(dir, "does-not-exist.jsonl.v1.bak"))).toBe(false);
    });

    test("auto-migration preserves body lines and assigns per-line CRC after migration", () => {
      // Larger fixture than the basic upgrade test — stresses that
      // every line gets its own CRC and that none are dropped or
      // reordered by the in-place rewrite.
      const sessionID = "mig-crc";
      const N = 25;
      const originalCalls = Array.from({ length: N }, (_, i) => ({
        tool: i % 2 === 0 ? "bash" : "edit",
        args: { i, cmd: `echo ${i}`, path: `./p-${i}.ts` },
        result: `out-${i}-${"x".repeat(15)}`,
        timestamp: 1700000000000 + i * 1000,
        callID: `crc-${String(i).padStart(3, "0")}`,
      }));
      writeV1File(sessionID, dir, originalCalls);

      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(N);

      // Every call comes back in order with its callID intact.
      for (let i = 0; i < N; i++) {
        expect(calls[i].callID).toBe(`crc-${String(i).padStart(3, "0")}`);
        expect(calls[i].timestamp).toBe(1700000000000 + i * 1000);
      }

      // The on-disk v2 file has 1 header + N body lines, each with a
      // numeric __crc.
      const v2Buf = readFileSync(filePath(sessionID, dir));
      const v2Lines = v2Buf.toString("utf-8").trim().split("\n");
      expect(v2Lines.length).toBe(1 + N);
      for (let i = 1; i < v2Lines.length; i++) {
        const obj = JSON.parse(v2Lines[i]) as Record<string, unknown>;
        expect(typeof obj.__crc).toBe("number");
        expect(typeof obj.callID).toBe("string");
        expect(obj.callID).toBe(`crc-${String(i - 1).padStart(3, "0")}`);
      }

      // The file-level CRC matches crc32() over the body bytes
      // (everything after the header line).
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      const headerEnd = v2Buf.indexOf(0x0a) + 1;
      const bodyBytes = v2Buf.subarray(headerEnd);
      expect(header.fileCrc32).toBe(crc32(bodyBytes));
    });
  });

  // -----------------------------------------------------------------------
  // Migration: idempotency (already-v2 file is a no-op)
  // -----------------------------------------------------------------------

  describe("auto-migration idempotency", () => {
    test("readToolCalls on an already-v2 file is a no-op (no backup created, file unchanged)", async () => {
      const sessionID = "mig-idem";
      const cp = createCheckpointTool({ enabled: true });

      for (let i = 0; i < 3; i++) {
        await cp.hooks["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID,
            callID: `idem-${i}`,
          },
          {
            output: `out-${i}`,
            metadata: { args: { i } },
          },
        );
      }
      cp.flushSession(sessionID);

      // Sanity: file is on v2.
      const beforeHeader = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(beforeHeader.version).toBe(2);

      // Read against an already-v2 file: no-op.
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(3);

      // No `.v1.bak` should have been created by the no-op path.
      expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);

      // File content is unchanged (version, offsets, CRC preserved).
      const afterHeader = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(afterHeader.version).toBe(2);
      expect(afterHeader.fileCrc32).toBe(beforeHeader.fileCrc32);
      expect(afterHeader.lineOffsets).toEqual(beforeHeader.lineOffsets);

      cp.cleanup();
    });
  });

  // -----------------------------------------------------------------------
  // Large session — 100 tool calls (stress)
  // -----------------------------------------------------------------------

  describe("large session", () => {
    test("writes 100 tool calls, header offsets + CRC match, all 100 are read back", async () => {
      const sessionID = "v2-large";
      const N = 100;
      const cp = createCheckpointTool({ enabled: true });

      for (let i = 0; i < N; i++) {
        await cp.hooks["tool.execute.after"]!(
          {
            tool: "bash",
            sessionID,
            callID: `L-${String(i).padStart(3, "0")}`,
          },
          {
            output: `payload-${i}-${"x".repeat(20)}`,
            metadata: { args: { i, cmd: `echo ${i}` } },
          },
        );
      }
      cp.flushSession(sessionID);

      const fileBuf = readFileSync(filePath(sessionID, dir));
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);

      // Offsets: one per body line, all point at '{'.
      expect(header.lineOffsets.length).toBe(N);
      for (let i = 0; i < N; i++) {
        const off = header.lineOffsets[i];
        expect(off).toBeGreaterThan(0);
        expect(off).toBeLessThan(fileBuf.length);
        expect(fileBuf[off]).toBe(0x7b); // "{"
      }

      // File-level CRC matches the body bytes we see on disk.
      const headerEnd = fileBuf.indexOf(0x0a) + 1;
      const bodyBytes = fileBuf.subarray(headerEnd);
      expect(header.fileCrc32).toBe(crc32(bodyBytes));

      // All 100 tool calls are recoverable.
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(calls[i].callID).toBe(`L-${String(i).padStart(3, "0")}`);
      }

      cp.cleanup();
    });
  });
});
