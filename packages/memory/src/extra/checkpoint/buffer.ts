// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Per-instance in-memory buffer + flush logic + LRU eviction.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// The buffer holds accumulated `ToolCall`s for each session before they
// are flushed to disk (either on threshold, periodic timer, or LRU
// eviction). The factory creates one `CheckpointBufferState` per
// `createCheckpointTool` invocation — there is no shared state between
// plugins.

import { defaultFsOps, type FsOps, createLogger } from "@sffmc/utilities";

import { crc32 } from "./crc";
import { buildV2Body, computeV2HeaderStr, readHeader } from "./header";
import { ensureDir, filePath } from "./paths";
import { readToolCallsShim } from "./reader";
import type {
  CheckpointBufferState,
  SessionBufferEntry,
  ToolCall,
} from "./types";

const log = createLogger("extra-checkpoint");

/** Monotonic counter for insertion ordering. Module-level because the
 *  LRU tie-breaker must be globally unique within a process. Each
 *  factory instance shares the counter (intentional — sessions
 *  inserted by different factories never coexist in the same buffer
 *  map, since the buffer is per-instance). */
let _bufferInsertionCounter = 0;

/** Flush a single session's buffer to disk. Merges the buffered calls
 *  with any existing on-disk calls so the header's `lineOffsets` index
 *  reflects the union. Preserves `createdAt` across flushes.
 *
 *  Accepts an optional `fs` injection for tests (defaults to `defaultFsOps`).
 *  Pass `createMockFsOps()` here to verify the flush pipeline without
 *  touching the real disk. */
export function flushSession(
  state: CheckpointBufferState,
  sessionID: string,
  fs: FsOps = defaultFsOps,
): void {
  const entry = state.sessionBuffers.get(sessionID);
  if (!entry || entry.buf.length === 0) return;

  ensureDir(state.dir, fs);

  const fp = filePath(sessionID, state.dir);
  const isNewFile = !state.headersWritten.has(sessionID);

  // For an existing file, load prior state so the new header reflects the
  // union (existing + new). `createdAt` is preserved across flushes.
  let existingCalls: ToolCall[] = [];
  let createdAt = Date.now();
  if (!isNewFile) {
    try {
      const priorHeader = readHeader(sessionID, state.dir, Number.MAX_SAFE_INTEGER, fs);
      if (priorHeader) createdAt = priorHeader.createdAt;
      existingCalls = readToolCallsShim(sessionID, state.dir, Number.MAX_SAFE_INTEGER, fs);
    } catch (e) {
      log.warn({ err: e, sessionID }, "checkpoint-buffer: prior-state load failed — treating as empty")
      // Treat as empty if reading fails — fall through to overwrite.
    }
  }

  const allCalls = [...existingCalls, ...entry.buf];

  // Build v2 body lines with stable key order and per-line CRC. Track
  // per-line byte length so offsets can be computed once the header size
  // is known.
  const { bodyConcat, bodyBytes, bodyLineBytes } = buildV2Body(allCalls);
  const fileCrc32 = crc32(bodyBytes);

  // Compute the final v2 header with converged line offsets. The header
  // size depends on the offsets it contains (digit counts grow with
  // offset values), so we iterate to a fixed point — typically ≤3
  // iterations for typical session sizes. `updatedAt` is captured once
  // and held constant across the iteration so the returned header
  // string and its serialized offsets agree byte-for-byte.
  const finalHeaderStr = computeV2HeaderStr(
    sessionID,
    bodyLineBytes,
    fileCrc32,
    createdAt,
    Date.now(),
  );

  // Write the file. For the first flush we use appendFile (single
  // syscall for header+body) — this preserves the v0.14.5 "batched
  // single-syscall" property. For subsequent flushes, writeFile is
  // required because the header's `lineOffsets` grew and must be
  // rewritten at byte offset 0; this is also a single syscall.
  if (isNewFile) {
    fs.appendFile(fp, finalHeaderStr + bodyConcat);
    state.headersWritten.add(sessionID);
  } else {
    fs.writeFile(fp, finalHeaderStr + bodyConcat);
  }
  entry.buf.length = 0;
}

/** Flush every session's buffer to disk. Called by the periodic timer
 *  and by `cleanup()`. */
export function flushAll(state: CheckpointBufferState, fs: FsOps = defaultFsOps): void {
  for (const sid of state.sessionBuffers.keys()) {
    flushSession(state, sid, fs);
  }
}

/** Start the periodic flush timer (no-op if already running). The
 *  timer is `unref()`'d so it never holds the process alive. */
export function startFlushTimer(state: CheckpointBufferState): void {
  if (state.flushTimer) return;
  state.flushTimer = setInterval(() => flushAll(state), state.flushIntervalMs);
  if (state.flushTimer && typeof state.flushTimer === "object" && "unref" in state.flushTimer) {
    state.flushTimer.unref();
  }
}

/** Stop the periodic flush timer (no-op if not running). */
export function stopFlushTimer(state: CheckpointBufferState): void {
  if (state.flushTimer) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
}

/** Find the LRU victim. Scans every entry and picks the one with the
 *  smallest `lastAccessMs`; ties are broken by `insertionOrder` (the
 *  older insertion wins). Returns `null` when the map is empty.
 *
 *  Exported (with underscore prefix) for the LRU eviction regression test. */
export function findLRUVictim(buffers: Map<string, SessionBufferEntry>): string | null {
  let victimKey: string | null = null;
  let victimAccess = Number.POSITIVE_INFINITY;
  let victimInsertion = Number.POSITIVE_INFINITY;
  for (const [key, entry] of buffers) {
    if (
      entry.lastAccessMs < victimAccess ||
      (entry.lastAccessMs === victimAccess && entry.insertionOrder < victimInsertion)
    ) {
      victimKey = key;
      victimAccess = entry.lastAccessMs;
      victimInsertion = entry.insertionOrder;
    }
  }
  return victimKey;
}

/** Get or create the buffer entry for `sessionID`. Touches the
 *  existing entry's `lastAccessMs` so it is no longer the eviction
 *  candidate. When the buffer is at capacity, flushes the LRU victim
 *  and evicts it. */
export function getOrCreateBuffer(state: CheckpointBufferState, sessionID: string): ToolCall[] {
  const now = Date.now();
  let entry = state.sessionBuffers.get(sessionID);
  if (entry) {
    // Touch: refresh the access timestamp so this entry is no longer
    // the eviction candidate. We also delete + re-insert to keep the
    // Map's iteration order aligned with LRU (defensive — eviction
    // uses the explicit scan, but iteration order is useful for tests
    // and for future fast paths).
    state.sessionBuffers.delete(sessionID);
    entry.lastAccessMs = now;
    state.sessionBuffers.set(sessionID, entry);
    return entry.buf;
  }
  // Evict LRU when the cap is reached. The victim is determined
  // by the explicit timestamp scan, not by Map iteration order.
  if (state.sessionBuffers.size >= state.maxBufferedSessions) {
    const victim = findLRUVictim(state.sessionBuffers);
    if (victim !== null) {
      flushSession(state, victim);
      state.sessionBuffers.delete(victim);
      state.headersWritten.delete(victim);
    }
  }
  entry = {
    buf: [],
    lastAccessMs: now,
    insertionOrder: _bufferInsertionCounter++,
  };
  state.sessionBuffers.set(sessionID, entry);
  return entry.buf;
}