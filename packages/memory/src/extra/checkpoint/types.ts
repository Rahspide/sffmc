// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Public types + the typed-error class exported from checkpoint.ts.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).
//
// These types were previously declared inline in the god-object module.
// Splitting them into their own file keeps the other modules focused on
// behavior and avoids circular type-imports.
//
// This module also owns the Valibot schemas used to validate on-disk
// checkpoint payloads (`JSONValue`, `ToolCall`, `CheckpointHeader v1/v2`,
// `CheckpointHeader` discriminated union, `CheckpointToolResult`,
// `RestoreActionResult`). All boundary parsing in checkpoint/* uses these
// schemas via `v.parse(...)` so the parsed values carry typed contracts
// instead of `Record<string, unknown>`.

import * as v from "valibot";

// ---------------------------------------------------------------------------
// Generic JSON-shape schema
// ---------------------------------------------------------------------------

/** Recursive schema for any JSON-compatible value (string/number/boolean/
 *  null/array/object). Used to validate inputs whose exact shape is not
 *  known statically (e.g. tool `output`/`metadata`, chat message bodies
 *  in transform hooks, recursive `sanitizeValue` walker). The lazy
 *  recursion breaks the cycle between `array(JSONValueSchema)` and the
 *  object form `record(v.string(), JSONValueSchema)`. */
export const JSONValueSchema: v.GenericSchema<unknown> = v.lazy(() =>
  v.union([
    v.string(),
    v.number(),
    v.boolean(),
    v.null(),
    v.array(JSONValueSchema),
    v.record(v.string(), JSONValueSchema),
  ]),
);
export type JSONValue = v.InferOutput<typeof JSONValueSchema>;

// ---------------------------------------------------------------------------
// ToolCall — one buffered tool call. Persisted as one JSONL body line.
// ---------------------------------------------------------------------------

export const ToolCallSchema = v.object({
  tool: v.string(),
  args: v.unknown(),
  result: v.unknown(),
  timestamp: v.number(),
  callID: v.string(),
});
/** One buffered tool call. Persisted as one JSONL body line. */
export type ToolCall = v.InferOutput<typeof ToolCallSchema>;

/** v2 on-disk body line: same fields as `ToolCall` plus the per-line
 *  `__crc` (CRC32 of the line without `__crc`). Used by tests to
 *  inspect on-disk shape; production code reads via `ToolCallSchema`
 *  and ignores `__crc` after verifying it. */
export const ToolCallV2BodyLineSchema = v.object({
  tool: v.string(),
  args: v.unknown(),
  result: v.unknown(),
  timestamp: v.number(),
  callID: v.string(),
  __crc: v.number(),
});
export type ToolCallV2BodyLine = v.InferOutput<typeof ToolCallV2BodyLineSchema>;

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

// ---------------------------------------------------------------------------
// Checkpoint header schemas (v1 + v2) — discriminated by `version`.
//
// The schemas use `partialCheck` + `looseObject` so they accept
// historically-tolerant payloads:
//   - `sessionID` may be missing on disk (legacy v1 writer bug);
//     migration fills the gap with the parameter `sessionID`.
//   - `createdAt` / `updatedAt` may be missing on disk; migration
//     falls back to `Date.now()`.
//
// Only `__type: "header"` and `version: 1|2` are strict. The
// downstream code re-narrows after parse so the rest of the
// pipeline only sees valid values.
// ---------------------------------------------------------------------------

/** v1 header schema. Pre-`lineOffsets`/`fileCrc32`. Auto-migrated to v2
 *  on first read. */
export const CheckpointHeaderV1Schema = v.looseObject({
  __type: v.literal("header"),
  version: v.literal(1),
});
export type CheckpointHeaderV1 = v.InferOutput<typeof CheckpointHeaderV1Schema>;

/** v2 header schema. Adds `lineOffsets` (byte offset of each body line
 *  from start of file) and `fileCrc32` (CRC32 of all body bytes). */
export const CheckpointHeaderV2Schema = v.looseObject({
  __type: v.literal("header"),
  version: v.literal(2),
});
export type CheckpointHeaderV2 = v.InferOutput<typeof CheckpointHeaderV2Schema>;

/** Discriminated union: any valid on-disk header (v1 or v2). v1 files
 *  are auto-migrated to v2 in `readHeader`; after migration the
 *  downstream code only sees v2. The union is exposed so test fixtures
 *  and the migration probe can speak either shape. */
export const CheckpointHeaderSchema = v.variant("version", [
  CheckpointHeaderV1Schema,
  CheckpointHeaderV2Schema,
]);
export type CheckpointHeader = v.InferOutput<typeof CheckpointHeaderSchema>;

/** Permissive header schema for tests / debug helpers that need to
 *  inspect arbitrary header fields. Only `__type: "header"` is
 *  required; every other field is `unknown` at the type level so
 *  callers must narrow before use. Production code should not use
 *  this — it bypasses the strict v1/v2 schemas above. */
export const CheckpointHeaderRawSchema = v.looseObject({
  __type: v.literal("header"),
});
export type CheckpointHeaderRaw = v.InferOutput<typeof CheckpointHeaderRawSchema>;

// ---------------------------------------------------------------------------
// Checkpoint tool — input + output schemas
// ---------------------------------------------------------------------------

/** Args accepted by the `extra_checkpoint` tool (action + optional
 *  sessionID; restore/list/delete share this shape). */
export const CheckpointToolArgsSchema = v.object({
  action: v.picklist(["list", "delete", "restore"]),
  sessionID: v.optional(v.string()),
});
export type CheckpointToolArgs = v.InferOutput<typeof CheckpointToolArgsSchema>;

/** Discriminated union of all possible tool results: list (sessions[]),
 *  delete (boolean), restore success (RestoreActionResult) / restore
 *  error. */
export const CheckpointToolResultSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), sessions: v.array(v.string()) }),
  v.object({ ok: v.literal(true), deleted: v.boolean() }),
  v.object({
    ok: v.literal(true),
    sessionID: v.string(),
    version: v.number(),
    toolCallCount: v.number(),
    messages: v.array(
      v.object({ role: v.literal("assistant"), content: v.string() }),
    ),
  }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);
export type CheckpointToolResult = v.InferOutput<typeof CheckpointToolResultSchema>;

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
  execute: (args?: CheckpointToolArgs) => Promise<CheckpointToolResult>;
}

/** Lifecycle hooks attached by the factory when the checkpoint is enabled. */
export interface CheckpointHooks {
  "tool.execute.after"?: (
    toolCtx: { tool: string; sessionID: string; callID: string },
    result: { output?: JSONValue; title?: string; metadata?: JSONValue },
  ) => Promise<void>;
  "experimental.chat.messages.transform"?: (
    _input: JSONValue,
    data: { messages: ChatMessage[] },
  ) => Promise<void>;
}

/** One chat message as seen by transform hooks. The unknown index
 *  signature mirrors OpenCode's pass-through shape — callers can read
 *  extra fields (e.g. `name`, `parts`) without the schema locking them
 *  out. The values are `JSONValue` so `metadata` is not `unknown`. */
export interface ChatMessage {
  role: string;
  content: string;
  [key: string]: JSONValue;
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

/** Discriminated union returned by the restore action. Error variants
 *  carry `error: string`; the success variant carries the reconstructed
 *  tool-call messages. */
export type RestoreActionResult =
  | { ok: false; error: string }
  | {
      ok: true;
      sessionID: string;
      version: number;
      toolCallCount: number;
      messages: Array<{ role: "assistant"; content: string }>;
    };

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