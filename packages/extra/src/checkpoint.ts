// SPDX-License-Identifier: MIT
// @sffmc/extra — Checkpoint
// Real implementation: session state capture, persistence to JSONL, restore.
//
// M-1 god-object refactor (Task 1.7) — this file is the public facade.
// Each concern now lives in its own module under ./checkpoint/. This file
// is being incrementally collapsed; the final state is a thin re-export
// shim. In-progress commits may temporarily hold a mix of inlined code
// and imports from the extracted modules.

import { appendFileSync, writeFileSync } from "node:fs";
import { createLogger, redactSecrets } from "@sffmc/shared";

import { crc32 } from "./checkpoint/crc.js";
import {
  CURRENT_VERSION,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_MAX_BUFFER_SESSIONS,
  DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
  DEFAULT_MAX_RESTORED_MESSAGES,
} from "./checkpoint/constants.js";
import {
  buildV2Body,
  computeV2HeaderStr,
  readHeader,
  writeHeader,
} from "./checkpoint/header.js";
import { migrateV1ToV2 } from "./checkpoint/migrations.js";
import { ensureDir, filePath, getCheckpointDir } from "./checkpoint/paths.js";
import {
  deleteCheckpoint,
  listSessions,
  readToolCallsShim,
} from "./checkpoint/reader.js";
import type {
  CheckpointHooks,
  CheckpointTool,
  SessionBufferEntry,
  ToolCall,
} from "./checkpoint/types.js";
import { CheckpointTooLargeError } from "./checkpoint/types.js";

export {
  crc32,
  __setCheckpointDir,
  filePath,
  CURRENT_VERSION,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BUFFER_SESSIONS,
  CheckpointTooLargeError,
} from "./checkpoint/index.js";
export type {
  CheckpointHooks,
  CheckpointTool,
  ToolCall,
  CheckpointState,
  MigrationResult,
  SessionBufferEntry,
} from "./checkpoint/index.js";

// Re-export the read API under its public name so the rest of this file
// can call `readToolCalls(...)` without the shim suffix.
export { readToolCallsShim as readToolCalls, listSessions } from "./checkpoint/reader.js";

const log = createLogger("extra-checkpoint");

// Local alias for in-file use.
const readToolCalls = readToolCallsShim;

// ---------------------------------------------------------------------------
// ToolCall read / list / delete  → ./checkpoint/reader.js
// Migration (v1 → v2)            → ./checkpoint/migrations.js
// ---------------------------------------------------------------------------

/** Per-session buffer entry with explicit LRU metadata.
 *
 *  Manriel LRU-eviction audit finding: the prior implementation
 *  relied on `Map.keys().next().value` + a `delete; set` touch to implement
 *  LRU via Map's iteration order. That worked but was implicit — the
 *  eviction logic depended on Map's internal ordering, not on a
 *  tracked access timestamp. This struct makes the LRU policy
 *  explicit: `lastAccessMs` is the value compared for eviction, and
 *  `insertionOrder` is the deterministic tie-breaker when two entries
 *  share the same access time. */
interface SessionBufferEntry {
  buf: ToolCall[];
  lastAccessMs: number;
  /** Monotonic counter assigned at insertion. Tie-breaker for LRU when
   *  two entries share `lastAccessMs` (e.g. when `Date.now()` does not
   *  advance between inserts). The lower value is older. */
  insertionOrder: number;
}

interface CheckpointBufferState {
  sessionBuffers: Map<string, SessionBufferEntry>;
  headersWritten: Set<string>;
  flushTimer: ReturnType<typeof setInterval> | null;
  dir: string;
  /** Buffer flush threshold (tool calls buffered before disk flush). */
  flushThreshold: number;
  /** Periodic flush interval in ms. */
  flushIntervalMs: number;
  /** Max in-memory session buffers (LRU eviction when exceeded). */
  maxBufferedSessions: number;
}

/** Monotonic counter for insertion ordering. Module-level because the
 *  LRU tie-breaker must be globally unique within a process. Each
 *  factory instance shares the counter (intentional — sessions
 *  inserted by different factories never coexist in the same buffer
 *  map, since the buffer is per-instance). */
let _bufferInsertionCounter = 0;

function _flushSession(state: CheckpointBufferState, sessionID: string): void {
  const entry = state.sessionBuffers.get(sessionID);
  if (!entry || entry.buf.length === 0) return;

  ensureDir(state.dir);

  const fp = filePath(sessionID, state.dir);
  const isNewFile = !state.headersWritten.has(sessionID);

  // For an existing file, load prior state so the new header reflects the
  // union (existing + new). `createdAt` is preserved across flushes.
  let existingCalls: ToolCall[] = [];
  let createdAt = Date.now();
  if (!isNewFile) {
    try {
      const priorHeader = readHeader(sessionID, state.dir, Number.MAX_SAFE_INTEGER);
      if (priorHeader) createdAt = priorHeader.createdAt;
      existingCalls = readToolCalls(sessionID, state.dir, Number.MAX_SAFE_INTEGER);
    } catch {
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

  // Write the file. For the first flush we use appendFileSync (single
  // syscall for header+body) — this preserves the v0.14.5 "batched
  // single-syscall" property. For subsequent flushes, writeFileSync is
  // required because the header's `lineOffsets` grew and must be
  // rewritten at byte offset 0; this is also a single syscall.
  if (isNewFile) {
    appendFileSync(fp, finalHeaderStr + bodyConcat);
    state.headersWritten.add(sessionID);
  } else {
    writeFileSync(fp, finalHeaderStr + bodyConcat);
  }
  entry.buf.length = 0;
}

function _flushAll(state: CheckpointBufferState): void {
  for (const sid of state.sessionBuffers.keys()) {
    _flushSession(state, sid);
  }
}

function _startFlushTimer(state: CheckpointBufferState): void {
  if (state.flushTimer) return;
  state.flushTimer = setInterval(() => _flushAll(state), state.flushIntervalMs);
  if (state.flushTimer && typeof state.flushTimer === "object" && "unref" in state.flushTimer) {
    state.flushTimer.unref();
  }
}

function _stopFlushTimer(state: CheckpointBufferState): void {
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
export function _findLRUVictim(buffers: Map<string, SessionBufferEntry>): string | null {
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

function _getOrCreateBuffer(state: CheckpointBufferState, sessionID: string): ToolCall[] {
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
    const victim = _findLRUVictim(state.sessionBuffers);
    if (victim !== null) {
      _flushSession(state, victim);
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

// ---------------------------------------------------------------------------
// Restore: reconstruct messages from ToolCalls
// ---------------------------------------------------------------------------

function reconstructMessages(
  calls: ToolCall[],
): Array<{ role: "assistant"; content: string }> {
  return calls.map(
    (tc) => ({
      role: "assistant" as const,
      content: `Tool ${tc.tool}(${JSON.stringify(tc.args)}) → ${JSON.stringify(tc.result)}`,
    }),
  );
}

// ---------------------------------------------------------------------------
// Auto-restore marker
// ---------------------------------------------------------------------------

const RESTORE_MARKER = /<!--\s*EXTRA_RESTORE:\s*(\S+)\s*-->/;

// ---------------------------------------------------------------------------
// Action handlers extracted from createCheckpointTool for readability
// ---------------------------------------------------------------------------

/** Execute the "restore" action — pure logic, no side effects beyond disk I/O. */
function _executeRestoreAction(
  sessionID: string | undefined,
  dir: string,
  maxFileSize: number,
): unknown {
  if (!sessionID) {
    return { ok: false, error: "sessionID is required for restore" };
  }

  let header: CheckpointHeader | null;
  try {
    header = readHeader(sessionID, dir, maxFileSize);
  } catch (e) {
    // Oversize error: translate the typed error into the existing
    // response shape so the public tool API is unchanged. Callers see
    // { ok: false, error: "<message>" }.
    if (e instanceof CheckpointTooLargeError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
  if (!header) {
    return { ok: false, error: "checkpoint not found" };
  }

  if (header.version > CURRENT_VERSION) {
    return {
      ok: false,
      error: `unknown checkpoint version: ${header.version} (current: ${CURRENT_VERSION})`,
    };
  }

  let calls: ToolCall[];
  try {
    calls = readToolCalls(sessionID, dir, maxFileSize);
  } catch (e) {
    if (e instanceof CheckpointTooLargeError) {
      return { ok: false, error: e.message };
    }
    throw e;
  }
  const messages = reconstructMessages(calls);

  return {
    ok: true,
    sessionID: header.sessionID,
    version: header.version,
    toolCallCount: calls.length,
    messages,
  };
}

/** Create the tool.execute.after hook that buffers tool calls. */
/** Recursively walk an unknown value, redacting any string leaves via
 *  `redactSecrets`. Non-string primitives pass through unchanged. Arrays and
 *  plain objects are walked element-by-element. Used by the redaction rule
 *  for checkpoint writes so secrets embedded in tool output are replaced
 *  with `[REDACTED:<category>]` markers BEFORE the JSONL line is written. */
function sanitizeResult(result: unknown): unknown {
  if (typeof result === "string") {
    return redactSecrets(result).redacted
  }
  if (Array.isArray(result)) {
    return result.map((v) => sanitizeResult(v))
  }
  if (result && typeof result === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(result as Record<string, unknown>)) {
      out[k] = sanitizeResult(v)
    }
    return out
  }
  return result
}

function _createToolExecuteAfterHook(
  state: CheckpointBufferState,
): (
  toolCtx: { tool: string; sessionID: string; callID: string },
  result: { output?: unknown; title?: string; metadata?: unknown },
) => Promise<void> {
  return async (toolCtx, result) => {
    const call: ToolCall = {
      tool: toolCtx.tool,
      args: (result.metadata as Record<string, unknown>)?.args ?? {},
      result: sanitizeResult(result.output),
      timestamp: Date.now(),
      callID: toolCtx.callID,
    };

    const buf = _getOrCreateBuffer(state, toolCtx.sessionID);
    buf.push(call);

    if (buf.length >= state.flushThreshold) {
      _flushSession(state, toolCtx.sessionID);
    }
  };
}

/** Create the experimental.chat.messages.transform hook for auto-restore. */
function _createAutoRestoreHook(
  dir: string,
  maxFileSize: number,
  maxRestoredMessages: number,
): (
  _input: unknown,
  data: {
    messages: Array<{ role: string; content: string; [key: string]: unknown }>;
  },
) => Promise<void> {
  return async (_input, data) => {
    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      if (typeof msg.content !== "string") continue;

        const match = msg.content.match(RESTORE_MARKER);
        if (match) {
          const sessionID = match[1];
          log.info(
            `[extra] checkpoint auto-restore: loading session ${sessionID}`,
          );

          // Oversize error: catch the typed error and degrade gracefully
          // — the auto-restore hook is best-effort and must not break the
          // chat pipeline. Strip the marker and continue.
          let header: CheckpointHeader | null;
          try {
            header = readHeader(sessionID, dir, maxFileSize);
          } catch (e) {
            if (e instanceof CheckpointTooLargeError) {
              log.warn(
                `[extra] checkpoint auto-restore: session ${sessionID} is oversize — skipping (${e.message})`,
              );
              msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
              continue;
            }
            throw e;
          }
          if (!header) {
            log.warn(
              `[extra] checkpoint auto-restore: session ${sessionID} not found`,
            );
            msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
            continue;
          }

          if (header.version > CURRENT_VERSION) {
            log.warn(
              `[extra] checkpoint auto-restore: session ${sessionID} has future version ${header.version} (current: ${CURRENT_VERSION})`,
            );
            msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
            continue;
          }

          // Oversize error: same catch for readToolCalls.
          let calls: ToolCall[];
          try {
            calls = readToolCalls(sessionID, dir, maxFileSize);
          } catch (e) {
            if (e instanceof CheckpointTooLargeError) {
              log.warn(
                `[extra] checkpoint auto-restore: session ${sessionID} tool calls oversize — skipping`,
              );
              msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
              continue;
            }
            throw e;
          }
          const restored = reconstructMessages(calls).slice(0, maxRestoredMessages);

          msg.content = msg.content.replace(RESTORE_MARKER, "").trim();

          if (msg.content === "") {
            data.messages.splice(i, 1, ...restored);
          } else {
            data.messages.splice(i + 1, 0, ...restored);
          }

          break;
        }
    }
    return data;
  };
}

// ---------------------------------------------------------------------------
// createCheckpointTool — returns { tool, hooks }
// ---------------------------------------------------------------------------

export function createCheckpointTool(config: {
  enabled: boolean;
  dir?: string;
  /** Initial release migration: max checkpoint file size in bytes.
   *  Files larger than this are rejected. Defaults to 10 MiB. */
  maxFileSize?: number;
  /** Initial release migration: max messages restored per checkpoint.
   *  Defaults to 50. */
  maxRestoredMessages?: number;
  /**  release migration: buffer flush threshold. The buffer
   *  is flushed to disk when this many tool calls accumulate for a
   *  single session. Defaults to 50. */
  flushThreshold?: number;
  /**  release migration: periodic flush interval in ms. A
   *  background timer flushes all buffered sessions at this interval.
   *  Defaults to 5_000 (5 s). */
  flushIntervalMs?: number;
  /**  release migration: max in-memory session buffers. When
   *  the cap is reached, the LRU session is flushed to disk and evicted.
   *  Defaults to 50. */
  maxBufferedSessions?: number;
}): {
  tool: CheckpointTool;
  hooks: CheckpointHooks;
  /** Flush a single session's buffer (uses this instance's state). */
  flushSession: (sessionID: string) => void;
  /** Flush all buffered sessions (uses this instance's state). */
  flushAll: () => void;
  /** Cleanup: flush all, stop timer, clear buffers. */
  cleanup: () => void;
} {
  const dir = config.dir || getCheckpointDir();
    // the prior hardcoded values, so behavior is unchanged when no YAML is
  // provided.
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_CHECKPOINT_FILE_SIZE;
  const maxRestoredMessages = config.maxRestoredMessages ?? DEFAULT_MAX_RESTORED_MESSAGES;
  const flushThreshold = config.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferedSessions = config.maxBufferedSessions ?? DEFAULT_MAX_BUFFER_SESSIONS;

  // Per-instance state (DLC: no shared state between plugins)
  const state: CheckpointBufferState = {
    sessionBuffers: new Map(),
    headersWritten: new Set(),
    flushTimer: null,
    dir,
    flushThreshold,
    flushIntervalMs,
    maxBufferedSessions,
  };

  const tool: CheckpointTool = {
    description: `Checkpoint — session snapshot and resumability.
Status: ${config.enabled ? "enabled" : "disabled"}.
Actions: list (show checkpointed sessions), restore (reconstruct messages), delete (remove checkpoint).
Auto-restore: inject <!-- EXTRA_RESTORE: <sessionID> --> in a message to auto-load checkpoint.`,

    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "delete", "restore"],
        },
        sessionID: {
          type: "string",
        },
      },
      required: ["action"],
    },

    execute: async (args?: { action: string; sessionID?: string }) => {
      if (!config.enabled) {
        return { ok: true, skipped: true, reason: "feature disabled" };
      }

      const action = args?.action;
      const sessionID = args?.sessionID;

      if (!action) {
        return { ok: false, error: "action is required" };
      }

      switch (action) {
        case "list": {
          const sessions = listSessions(dir);
          return { ok: true, sessions };
        }

        case "delete": {
          if (!sessionID) {
            return { ok: false, error: "sessionID is required for delete" };
          }
          const deleted = deleteCheckpoint(sessionID, dir);
          if (deleted) {
            state.sessionBuffers.delete(sessionID);
            state.headersWritten.delete(sessionID);
          }
          return { ok: true, deleted };
        }

        case "restore": {
          return _executeRestoreAction(sessionID, dir, maxFileSize);
        }

        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
    },
  };

  // ---- hooks ----

  const hooks: CheckpointHooks = {};

  if (config.enabled) {
    hooks["tool.execute.after"] = _createToolExecuteAfterHook(state);

    hooks["experimental.chat.messages.transform"] = _createAutoRestoreHook(
      dir,
      maxFileSize,
      maxRestoredMessages,
    );

    _startFlushTimer(state);
  }

  return {
    tool,
    hooks,
    flushSession: (sessionID: string) => _flushSession(state, sessionID),
    flushAll: () => _flushAll(state),
    cleanup: () => {
      _flushAll(state);
      _stopFlushTimer(state);
      state.sessionBuffers.clear();
      state.headersWritten.clear();
    },
  };
}
