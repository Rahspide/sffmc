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

import {
  flushAll as flushAllBuffers,
  flushSession,
  findLRUVictim,
  getOrCreateBuffer,
  startFlushTimer,
  stopFlushTimer,
} from "./checkpoint/buffer.js";
import {
  CURRENT_VERSION,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD,
  DEFAULT_MAX_BUFFER_SESSIONS,
  DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
  DEFAULT_MAX_RESTORED_MESSAGES,
} from "./checkpoint/constants.js";
import { migrateV1ToV2 } from "./checkpoint/migrations.js";
import { ensureDir, filePath, getCheckpointDir } from "./checkpoint/paths.js";
import { readHeader } from "./checkpoint/header.js";
import {
  deleteCheckpoint,
  listSessions,
  readToolCallsShim,
} from "./checkpoint/reader.js";
import type {
  CheckpointBufferState,
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

// Re-export the LRU helper under its public name (with the leading
// underscore convention preserved for the regression test in
// packages/memory/test/checkpoint.test.ts).
export { findLRUVictim as _findLRUVictim } from "./checkpoint/buffer.js";

const log = createLogger("extra-checkpoint");

// Local alias for in-file use.
const readToolCalls = readToolCallsShim;

// ---------------------------------------------------------------------------
// ToolCall read / list / delete  → ./checkpoint/reader.js
// Migration (v1 → v2)            → ./checkpoint/migrations.js
// In-memory buffer + LRU         → ./checkpoint/buffer.js
// ---------------------------------------------------------------------------

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

    const buf = getOrCreateBuffer(state, toolCtx.sessionID);
    buf.push(call);

    if (buf.length >= state.flushThreshold) {
      flushSession(state, toolCtx.sessionID);
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

    startFlushTimer(state);
  }

  return {
    tool,
    hooks,
    flushSession: (sessionID: string) => flushSession(state, sessionID),
    flushAll: () => flushAllBuffers(state),
    cleanup: () => {
      flushAllBuffers(state);
      stopFlushTimer(state);
      state.sessionBuffers.clear();
      state.headersWritten.clear();
    },
  };
}
