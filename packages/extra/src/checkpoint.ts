// SPDX-License-Identifier: MIT
// @sffmc/extra — Checkpoint
// Real implementation: session state capture, persistence to JSONL, restore.
//
// M-1 god-object refactor (Task 1.7) — this file is the public facade.
// Each concern now lives in its own module under ./checkpoint/. This file
// is being incrementally collapsed; the final state is a thin re-export
// shim. In-progress commits may temporarily hold a mix of inlined code
// and imports from the extracted modules.

import { createLogger } from "@sffmc/shared";

import {
  flushAll as flushAllBuffers,
  flushSession,
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
import {
  createAutoRestoreHook,
  createToolExecuteAfterHook,
} from "./checkpoint/hooks.js";
import { migrateV1ToV2 } from "./checkpoint/migrations.js";
import { getCheckpointDir } from "./checkpoint/paths.js";
import {
  deleteCheckpoint,
  listSessions,
  readToolCallsShim,
} from "./checkpoint/reader.js";
import { executeRestoreAction } from "./checkpoint/restore.js";
import type {
  CheckpointBufferState,
  CheckpointHooks,
  CheckpointTool,
  ToolCall,
} from "./checkpoint/types.js";

const log = createLogger("extra-checkpoint");

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

// Local alias for in-file use.
const readToolCalls = readToolCallsShim;

// ---------------------------------------------------------------------------
// ToolCall read / list / delete  → ./checkpoint/reader.js
// Migration (v1 → v2)            → ./checkpoint/migrations.js
// In-memory buffer + LRU         → ./checkpoint/buffer.js
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Restore + hook creators  → ./checkpoint/restore.js + ./checkpoint/hooks.js
// ---------------------------------------------------------------------------

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
          return executeRestoreAction(sessionID, dir, maxFileSize);
        }

        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
    },
  };

  // ---- hooks ----

  const hooks: CheckpointHooks = {};

  if (config.enabled) {
    hooks["tool.execute.after"] = createToolExecuteAfterHook(state);

    hooks["experimental.chat.messages.transform"] = createAutoRestoreHook(
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
