// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Public types + the typed-error class exported from checkpoint.ts.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// These types were previously declared inline in the god-object module.
// Splitting them into their own file keeps the other modules focused on
// behavior and avoids circular type-imports.

/** One buffered tool call. Persisted as one JSONL body line. */
export interface ToolCall {
  tool: string;
  args: unknown;
  result: unknown;
  timestamp: number;
  callID: string;
}

/** Snapshot of a checkpoint file's metadata + tool-call history.
 *  Returned by future readers; not yet consumed by the public API. */
export interface CheckpointState {
  sessionID: string;
  toolCalls: ToolCall[];
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** Typed error thrown by `readHeader()` and `readToolCalls()` when the
 *  on-disk file exceeds `maxFileSize`. Callers in this package catch
 *  `CheckpointTooLargeError` and convert to the existing
 *  `{ ok: false, error: "..." }` response shape so the public tool API
 *  is unchanged. */
export class CheckpointTooLargeError extends Error {
  readonly sessionID: string;
  readonly fileSize: number;
  readonly maxFileSize: number;
  constructor(sessionID: string, fileSize: number, maxFileSize: number) {
    super(
      `Checkpoint "${sessionID}" file size ${(fileSize / 1024 / 1024).toFixed(1)}MB exceeds limit (${(maxFileSize / 1024 / 1024).toFixed(1)}MB)`,
    );
    this.name = "CheckpointTooLargeError";
    this.sessionID = sessionID;
    this.fileSize = fileSize;
    this.maxFileSize = maxFileSize;
  }
}

/** OpenCode-style tool descriptor for the checkpoint tool. */
export interface CheckpointTool {
  description: string;
  parameters: {
    type: "object";
    properties: {
      action: { type: "string"; enum: string[] };
      sessionID: { type: "string" };
    };
    required: string[];
  };
  execute: (args?: { action: string; sessionID?: string }) => Promise<unknown>;
}

/** Lifecycle hooks attached by the factory when the checkpoint is enabled. */
export interface CheckpointHooks {
  "tool.execute.after"?: (
    toolCtx: { tool: string; sessionID: string; callID: string },
    result: { output?: unknown; title?: string; metadata?: unknown },
  ) => Promise<void>;
  "experimental.chat.messages.transform"?: (
    _input: unknown,
    data: { messages: Array<{ role: string; content: string; [key: string]: unknown }> },
  ) => Promise<void>;
}

/** Result of a v1 → v2 migration attempt. `ok=false` cases include a
 *  human-readable `error`. `sourceVersion` / `targetVersion` always
 *  reflect the requested transition. */
export interface MigrationResult {
  ok: boolean;
  sourceVersion: 1 | 2;
  targetVersion: 2;
  lines: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal types (used across buffer.ts / hooks.ts / factory.ts)
// ---------------------------------------------------------------------------

/** Per-session buffer entry with explicit LRU metadata.
 *
 *  `lastAccessMs` is the value compared for eviction, and
 *  `insertionOrder` is the deterministic tie-breaker when two entries
 *  share the same access time. */
export interface SessionBufferEntry {
  buf: ToolCall[];
  lastAccessMs: number;
  /** Monotonic counter assigned at insertion. Tie-breaker for LRU when
   *  two entries share `lastAccessMs` (e.g. when `Date.now()` does not
   *  advance between inserts). The lower value is older. */
  insertionOrder: number;
}

/** Per-factory-instance state. No shared state between plugins
 *  (each call to `createCheckpointTool` returns a new state). */
export interface CheckpointBufferState {
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