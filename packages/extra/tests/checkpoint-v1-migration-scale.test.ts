// SPDX-License-Identifier: MIT
// @sffmc/extra — checkpoint-v1-migration-scale.test.ts
//
// Edge case tests for v0.14.9 v1→v2 auto-migration at scale and with
// filesystem anomalies. Probes for performance, correctness, and
// atomicity bugs.
//
// Coverage:
//   1. Large v1 file (N=1000 tool calls) — auto-migration preserves all
//      lines + correct per-line CRCs, runs within reasonable time.
//   2. Concurrent reads + auto-migrate — multiple migrate calls produce
//      a consistent v2 result (only one actual upgrade; rest are no-ops).
//   3. Read-only v1 file (no write permission) — migration gracefully
//      fails without crashing or corrupting the original file.
//   4. Migration to existing v2 file — no-op path does not corrupt
//      the existing v2 file.
//   5. v1 with extra trailing whitespace + multiple blank lines —
//      graceful behavior (v1 reader's trim() handles malformed input).
//
// See checkpoint.ts for the on-disk format and the migrateV1ToV2
// implementation.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";

import {
  crc32,
  createCheckpointTool,
  filePath,
  migrateV1ToV2,
  readToolCalls,
  __setCheckpointDir,
} from "../src/checkpoint";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpCheckpointDir(): string {
  return mkdtempSync(join(tmpdir(), "sffmc-v1scale-"));
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
 *  is not a valid JSON header. Mirrors the implementation's readHeader
 *  semantics for the test paths that need to assert on the on-disk
 *  shape (since `readHeader` is module-internal). */
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

/** Build a v1-format checkpoint file with N tool calls. Each call has a
 *  unique callID `tc-<padded-i>`, a `payload-<i>` string in args, and a
 *  `result-<i>` string. */
function writeV1WithCalls(sessionID: string, dir: string, n: number): string {
  const header = JSON.stringify({
    __type: "header",
    sessionID,
    version: 1,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  });
  const body =
    Array.from({ length: n }, (_, i) =>
      JSON.stringify({
        tool: "test",
        args: { i, payload: `payload-${i}` },
        result: `result-${i}`,
        timestamp: 1_700_000_000_000 + i,
        callID: `tc-${String(i).padStart(4, "0")}`,
      }),
    ).join("\n") + "\n";
  const fp = filePath(sessionID, dir);
  writeFileSync(fp, header + "\n" + body, "utf-8");
  return fp;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("v1 auto-migration: scale + filesystem edge cases", () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpCheckpointDir();
    __setCheckpointDir(dir);
  });

  afterEach(() => {
    // Restore permissions before recursive delete (the chmod 0o444 test
    // would otherwise leave files that rmSync cannot remove on some
    // platforms). Best-effort: ignore failures, force:true is the
    // safety net.
    try {
      const files = readdirSync(dir);
      for (const f of files) {
        try {
          chmodSync(join(dir, f), 0o644);
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
    rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. Large v1 file (N=1000 tool calls)
  // -----------------------------------------------------------------------

  test(
    "large v1 file (N=1000 tool calls) auto-migrates with all lines + correct per-line CRCs",
    () => {
      const sessionID = "v1-large-1k";
      const N = 1000;

      const fp = writeV1WithCalls(sessionID, dir, N);
      const sizeBefore = statSync(fp).size;

      const t0 = performance.now();
      const result = migrateV1ToV2(sessionID, dir);
      const elapsedMs = performance.now() - t0;

      const sizeAfter = statSync(fp).size;
      const backupPath = join(dir, `${sessionID}.jsonl.v1.bak`);

      // Migration succeeded
      expect(result.ok).toBe(true);
      expect(result.sourceVersion).toBe(1);
      expect(result.targetVersion).toBe(2);
      expect(result.lines).toBe(N);
      expect(result.error).toBeUndefined();

      // Backup exists with original v1 size (byte-for-byte preserved)
      expect(existsSync(backupPath)).toBe(true);
      expect(statSync(backupPath).size).toBe(sizeBefore);

      // New v2 file is on v2 with correct offset count + CRC fields
      const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
      expect(header).not.toBeNull();
      expect(header.version).toBe(2);
      expect(header.sessionID).toBe(sessionID);
      expect(Array.isArray(header.lineOffsets)).toBe(true);
      expect(header.lineOffsets.length).toBe(N);
      expect(typeof header.fileCrc32).toBe("number");

      // All N tool calls preserved
      const calls = readToolCalls(sessionID, dir);
      expect(calls.length).toBe(N);
      for (let i = 0; i < N; i++) {
        expect(calls[i].callID).toBe(`tc-${String(i).padStart(4, "0")}`);
        expect(calls[i].tool).toBe("test");
        expect(calls[i].args).toEqual({ i, payload: `payload-${i}` });
        expect(calls[i].result).toBe(`result-${i}`);
      }

      // File-level CRC matches body bytes
      const v2Buf = readFileSync(filePath(sessionID, dir));
      const headerEnd = v2Buf.indexOf(0x0a) + 1;
      const bodyBytes = v2Buf.subarray(headerEnd);
      expect(crc32(bodyBytes)).toBe(header.fileCrc32);

      // Per-line CRCs are correct: each line's __crc equals crc32() of the
      // line WITHOUT the __crc field. This matches buildV2BodyLine in
      // checkpoint.ts.
      const v2Text = v2Buf.toString("utf-8");
      const v2Lines = v2Text.trim().split("\n");
      expect(v2Lines.length).toBe(N + 1); // 1 header + N calls
      for (let i = 1; i < v2Lines.length; i++) {
        const obj = JSON.parse(v2Lines[i]) as Record<string, unknown>;
        expect(typeof obj.__crc).toBe("number");

        // Reconstruct the line without __crc (in the stable key order
        // used by buildV2BodyLine) and verify the CRC.
        const lineNoCrc = JSON.stringify({
          tool: obj.tool,
          args: obj.args,
          result: obj.result,
          timestamp: obj.timestamp,
          callID: obj.callID,
        });
        expect(crc32(lineNoCrc)).toBe(obj.__crc);
      }

      // Performance sanity: should be fast (well under 30s for 1000 lines)
      expect(elapsedMs).toBeLessThan(30_000);

      // Surface timing/size in the test output for the task report
      console.log(
        `[v1-large-1k] sizeBefore=${sizeBefore}B sizeAfter=${sizeAfter}B elapsed=${elapsedMs.toFixed(1)}ms`,
      );
    },
    30_000,
  );

  // -----------------------------------------------------------------------
  // 2. Concurrent reads + auto-migrate
  // -----------------------------------------------------------------------

  test("concurrent migrateV1ToV2 calls produce consistent v2 result (only one upgrade)", async () => {
    const sessionID = "v1-concurrent";
    const N = 100;

    writeV1WithCalls(sessionID, dir, N);

    // Fire two migrations "in parallel". Note: Bun's test runner runs
    // sync code sequentially on the main thread, so these calls execute
    // in left-to-right order:
    //   call 1 → reads v1 → writes v2 (sourceVersion=1)
    //   call 2 → reads v2 → no-op (sourceVersion=2)
    // The contract being tested: regardless of ordering, the final state
    // is a consistent v2 file with all N calls preserved.
    const [r1, r2] = await Promise.all([
      Promise.resolve(migrateV1ToV2(sessionID, dir)),
      Promise.resolve(migrateV1ToV2(sessionID, dir)),
    ]);

    // Both report success.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);

    // Exactly one is an actual upgrade (sourceVersion=1) and exactly one
    // is a no-op (sourceVersion=2). This proves the migration is not
    // performed redundantly.
    const upgrades = [r1, r2].filter(
      (r) => r.sourceVersion === 1 && r.targetVersion === 2,
    );
    const noops = [r1, r2].filter(
      (r) => r.sourceVersion === 2 && r.targetVersion === 2,
    );
    expect(upgrades.length).toBe(1);
    expect(noops.length).toBe(1);

    // Both report the correct line count.
    expect(upgrades[0]?.lines).toBe(N);
    expect(noops[0]?.lines).toBe(N);

    // Final state: valid v2 with all N calls preserved.
    const header = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
    expect(header).not.toBeNull();
    expect(header.version).toBe(2);
    expect(header.lineOffsets.length).toBe(N);

    const calls = readToolCalls(sessionID, dir);
    expect(calls.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(calls[i].callID).toBe(`tc-${String(i).padStart(4, "0")}`);
    }

    // Backup exists (created by the first migration's upgrade path).
    expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 3. Read-only v1 file (no write permission)
  // -----------------------------------------------------------------------

  test("migration gracefully fails when v1 file is read-only (chmod 0o444)", () => {
    const sessionID = "v1-readonly";

    // Skip the assertion if running as root — root bypasses file mode
    // permission checks (DAC), so 0o444 files are still writable. This
    // is a known platform behavior, not a bug. Logged as a probe finding.
    const runningAsRoot =
      typeof process.getuid === "function" && process.getuid() === 0;

    const fp = writeV1WithCalls(sessionID, dir, 5);
    const sizeBefore = statSync(fp).size;
    const bytesBefore = readFileSync(fp);

    // Make file read-only
    chmodSync(fp, 0o444);

    const result = migrateV1ToV2(sessionID, dir);

    if (runningAsRoot) {
      // root bypass: the write may succeed (file mode ignored). Document
      // the observed behavior without asserting a failure. Either way,
      // the implementation must not throw — graceful return only.
      console.log(
        `[v1-readonly] running as root: chmod 0o444 bypassed, ok=${result.ok} error=${result.error ?? "<none>"}`,
      );
      // result should be a valid MigrationResult (no thrown exception)
      expect(typeof result.ok).toBe("boolean");
      expect(typeof result.lines).toBe("number");
      return;
    }

    // Non-root: write must fail gracefully (no crash, no exception escape).
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    // Error message must mention write failure (the implementation's
    // writeFileSync failure is wrapped as `write failed: <EACCES ...>`).
    expect(result.error!.toLowerCase()).toContain("write");

    // Original v1 file is preserved byte-for-byte (no corruption).
    expect(existsSync(fp)).toBe(true);
    expect(statSync(fp).size).toBe(sizeBefore);
    expect(readFileSync(fp)).toEqual(bytesBefore);
    const v1Header = readHeaderFromDisk(sessionID, dir);
    expect(v1Header).not.toBeNull();
    expect(v1Header!.version).toBe(1);

    // A backup file is created during the failed migration attempt — this
    // is documented behavior (backup before rewrite). The implementation
    // does not undo the backup on failure, which is a defensible choice
    // (preserves the original v1 in .v1.bak as recovery).
    expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 4. Migration to existing v2 file
  // -----------------------------------------------------------------------

  test("migrating an already-v2 file is a no-op (does not corrupt v2)", async () => {
    const sessionID = "v2-noop";
    const N = 4;

    // First write a v2 file via the implementation's flush path
    const cp = createCheckpointTool({ enabled: true, dir });
    for (let i = 0; i < N; i++) {
      await cp.hooks["tool.execute.after"]!(
        { tool: "bash", sessionID, callID: `noop-${i}` },
        { output: `o-${i}`, metadata: { args: { i } } },
      );
    }
    cp.flushSession(sessionID);

    // Capture the v2 file state before migration
    const fp = filePath(sessionID, dir);
    const bytesBefore = readFileSync(fp);
    const headerBefore = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
    expect(headerBefore).not.toBeNull();
    expect(headerBefore.version).toBe(2);
    expect(headerBefore.lineOffsets.length).toBe(N);

    // Run migration on the already-v2 file
    const result = migrateV1ToV2(sessionID, dir);

    // No-op success: sourceVersion === targetVersion === 2
    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(2);
    expect(result.targetVersion).toBe(2);
    expect(result.lines).toBe(N);
    expect(result.error).toBeUndefined();

    // No backup should have been created (no-op path does not back up).
    expect(existsSync(join(dir, `${sessionID}.jsonl.v1.bak`))).toBe(false);

    // File bytes are bit-identical (no-op means no rewrite).
    const bytesAfter = readFileSync(fp);
    expect(bytesAfter.equals(bytesBefore)).toBe(true);

    // v2 header preserved
    const headerAfter = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
    expect(headerAfter).not.toBeNull();
    expect(headerAfter.version).toBe(2);
    expect(headerAfter.lineOffsets.length).toBe(N);
    expect(headerAfter.fileCrc32).toBe(headerBefore.fileCrc32);
    expect(headerAfter.lineOffsets).toEqual(headerBefore.lineOffsets);
    expect(headerAfter.createdAt).toBe(headerBefore.createdAt);
    expect(headerAfter.updatedAt).toBe(headerBefore.updatedAt);

    // Tool calls still readable with same content
    const calls = readToolCalls(sessionID, dir);
    expect(calls.length).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(calls[i].callID).toBe(`noop-${i}`);
    }

    cp.cleanup();
  });

  // -----------------------------------------------------------------------
  // 5. v1 with extra trailing whitespace + multiple blank lines
  // -----------------------------------------------------------------------

  test("v1 file with trailing whitespace + blank lines migrates gracefully", () => {
    const sessionID = "v1-whitespace";

    // Build a v1 file with: leading blank line, trailing whitespace on
    // body lines, multiple blank lines between calls, and trailing
    // blank lines after the last call. The v1 read path uses trim()
    // and skips empty lines, so this must parse cleanly.
    const header = JSON.stringify({
      __type: "header",
      sessionID,
      version: 1,
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    });
    const callA = JSON.stringify({
      tool: "bash",
      args: {},
      result: "r1",
      timestamp: 1,
      callID: "w-1",
    });
    const callB = JSON.stringify({
      tool: "grep",
      args: {},
      result: "r2",
      timestamp: 2,
      callID: "w-2",
    });
    const callC = JSON.stringify({
      tool: "read",
      args: {},
      result: "r3",
      timestamp: 3,
      callID: "w-3",
    });

    // Compose body with whitespace noise:
    //   leading "\n", trailing "   " on call A, two blank lines, trailing
    //   "\t" on call B, blank line, trailing " " on call C, three trailing
    //   blank lines.
    const body =
      "\n" +
      callA +
      "   \n" +
      "\n\n" +
      callB +
      "\t\n" +
      "\n" +
      callC +
      " \n" +
      "\n\n\n";

    const fp = filePath(sessionID, dir);
    writeFileSync(fp, header + "\n" + body, "utf-8");

    const result = migrateV1ToV2(sessionID, dir);

    // Should succeed gracefully: v1 reader's trim() strips whitespace and
    // skips blank lines, producing 3 valid calls.
    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toBe(1);
    expect(result.targetVersion).toBe(2);
    expect(result.lines).toBe(3);
    expect(result.error).toBeUndefined();

    // Verify all 3 calls were preserved in the migrated v2 file.
    const migratedCalls = readToolCalls(sessionID, dir);
    expect(migratedCalls.length).toBe(3);
    expect(migratedCalls[0].callID).toBe("w-1");
    expect(migratedCalls[0].tool).toBe("bash");
    expect(migratedCalls[1].callID).toBe("w-2");
    expect(migratedCalls[1].tool).toBe("grep");
    expect(migratedCalls[2].callID).toBe("w-3");
    expect(migratedCalls[2].tool).toBe("read");

    // v2 header has 3 line offsets (one per call).
    const header2 = readHeaderFromDisk(sessionID, dir) as unknown as V2HeaderShape;
    expect(header2).not.toBeNull();
    expect(header2.version).toBe(2);
    expect(header2.lineOffsets.length).toBe(3);
  });
});