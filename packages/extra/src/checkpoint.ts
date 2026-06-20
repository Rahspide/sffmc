// SPDX-License-Identifier: MIT
// @sffmc/extra — F5' Checkpoint
// Real implementation: session state capture, persistence to JSONL, restore.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger, redactSecrets } from "@sffmc/shared";

const log = createLogger("extra-checkpoint");

export interface ToolCall {
  tool: string;
  args: unknown;
  result: unknown;
  timestamp: number;
  callID: string;
}

export interface CheckpointState {
  sessionID: string;
  toolCalls: ToolCall[];
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** C3 (Manriel audit, v0.14.2): typed error thrown by `readHeader()` and
 *  `readToolCalls()` when the on-disk file exceeds `maxFileSize`.
 *  Previously, `readHeader()` returned `null` and `readToolCalls()`
 *  returned `[]` for the oversize case, which made it impossible for
 *  callers to distinguish "checkpoint missing" from "checkpoint too
 *  large" — both surfaced as empty results. Callers in this file catch
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
//
// Phase-1 (v0.14.2) HIGH-severity migration — see
// .slim/deepwork/hardcode-audit-2026-06.md (E1, E2).
//
// `MAX_CHECKPOINT_FILE_SIZE` and `MAX_RESTORED_MESSAGES` were hardcoded
// module-level constants. They are now configurable via the factory's
// `config.maxFileSize` and `config.maxRestoredMessages` (defaults match the
// previous hardcoded values, so behavior is unchanged when no YAML is
// provided). The original values are preserved as `DEFAULT_*` so callers
// that omit the new fields still see the prior behavior.

/** Default max checkpoint file size in bytes (E1). Overridable via
 *  `ExtraConfig.checkpoint_max_file_size`. */
const DEFAULT_MAX_CHECKPOINT_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

/** Default max restored messages per checkpoint (E2). Overridable via
 *  `ExtraConfig.checkpoint_max_restored_messages`. */
const DEFAULT_MAX_RESTORED_MESSAGES = 50;

const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 5_000;
export const CURRENT_VERSION = 1;

/** Maximum number of sessions tracked in the in-memory buffer map.
 *  Prevents unbounded memory growth when many sessions are active.
 *  Least-recently-used sessions are flushed to disk and evicted when exceeded. */
const MAX_BUFFER_SESSIONS = 50;

// ---------------------------------------------------------------------------
// Storage path — overridable for tests
// ---------------------------------------------------------------------------

let _overrideDir: string | null = null;

export function __setCheckpointDir(dir: string): void {
  _overrideDir = dir;
}

function getCheckpointDir(): string {
  if (_overrideDir) return _overrideDir;
  return join(homedir(), ".local", "share", "sffmc", "extra", "checkpoints");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function filePath(sessionID: string, dir?: string): string {
  return join(dir ?? getCheckpointDir(), `${sessionID}.jsonl`);
}

// ---------------------------------------------------------------------------
// Header (schema versioning)
// ---------------------------------------------------------------------------

interface CheckpointHeader {
  __type: "header";
  sessionID: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

function writeHeader(sessionID: string, dir?: string): void {
  const fp = filePath(sessionID, dir);
  const d = dir ?? getCheckpointDir();
  ensureDir(d);

  const now = Date.now();
  const header: CheckpointHeader = {
    __type: "header",
    sessionID,
    version: CURRENT_VERSION,
    createdAt: now,
    updatedAt: now,
  };
  appendFileSync(fp, JSON.stringify(header) + "\n");
}

function readHeader(
  sessionID: string,
  dir?: string,
  maxFileSize: number = DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
): CheckpointHeader | null {
  const fp = filePath(sessionID, dir);

  try {
    const st = statSync(fp);
    if (st.size > maxFileSize) {
      log.warn(
        `checkpoint: skipping ${sessionID} — file size ${(st.size / 1024 / 1024).toFixed(1)}MB exceeds limit (${maxFileSize / 1024 / 1024}MB)`,
      );
      // C3: throw a typed error so callers can distinguish "oversize"
      // from "missing file" (which still returns null).
      throw new CheckpointTooLargeError(sessionID, st.size, maxFileSize);
    }
  } catch (e) {
    if (e instanceof CheckpointTooLargeError) throw e;
    return null;
  }

  try {
    const raw = readFileSync(fp, "utf-8");
    const firstLine = raw.split("\n")[0]?.trim();
    if (!firstLine) return null;

    const parsed = JSON.parse(firstLine) as Record<string, unknown>;
    if (parsed.__type !== "header") return null;
    return parsed as unknown as CheckpointHeader;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// ToolCall read / list / delete
// ---------------------------------------------------------------------------

export function readToolCalls(
  sessionID: string,
  dir?: string,
  maxFileSize: number = DEFAULT_MAX_CHECKPOINT_FILE_SIZE,
): ToolCall[] {
  const fp = filePath(sessionID, dir);

  // Stat-based size check before loading into memory.
  try {
    const st = statSync(fp);
    if (st.size > maxFileSize) {
      log.warn(
        `checkpoint: skipping ${sessionID} — file size ${(st.size / 1024 / 1024).toFixed(1)}MB exceeds limit (${maxFileSize / 1024 / 1024}MB)`,
      );
      // C3: throw a typed error so callers can distinguish "oversize"
      // from "missing file" (which still returns []).
      throw new CheckpointTooLargeError(sessionID, st.size, maxFileSize);
    }
  } catch (e) {
    if (e instanceof CheckpointTooLargeError) throw e;
    return [];
  }

  let fileBuf: Buffer;
  try {
    fileBuf = readFileSync(fp);
  } catch {
    return [];
  }

  // buf.length is the file size — cheap early-exit on empty files
  // (equivalent to what a stat() pre-check would have given us).
  if (fileBuf.length === 0) return [];

  const raw = fileBuf.toString("utf-8");
  const lines = raw.trim().split("\n");
  const calls: ToolCall[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj.__type === "header") continue;
      if (
        typeof obj.tool === "string" &&
        typeof obj.timestamp === "number" &&
        typeof obj.callID === "string"
      ) {
        calls.push(obj as unknown as ToolCall);
      }
    } catch {
      // Skip malformed lines
    }
  }
  return calls;
}

export function listSessions(dir?: string): string[] {
  const d = dir ?? getCheckpointDir();
  if (!existsSync(d)) return [];

  try {
    const files = readdirSync(d);
    return files
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    return [];
  }
}

function deleteCheckpoint(sessionID: string, dir?: string): boolean {
  const fp = filePath(sessionID, dir);
  if (!existsSync(fp)) return false;
  try {
    unlinkSync(fp);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// In-memory buffer — per-instance state (DLC: no shared state between plugins)
// ---------------------------------------------------------------------------

/** Per-session buffer entry with explicit LRU metadata.
 *
 *  C2 (Manriel audit, v0.14.2): the prior implementation relied on
 *  `Map.keys().next().value` + a `delete; set` touch to implement LRU
 *  via Map's iteration order. That worked but was implicit — the
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

  if (!state.headersWritten.has(sessionID)) {
    writeHeader(sessionID, state.dir);
    state.headersWritten.add(sessionID);
  }

  const fp = filePath(sessionID, state.dir);
  for (const tc of entry.buf) {
    appendFileSync(fp, JSON.stringify(tc) + "\n");
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
  state.flushTimer = setInterval(() => _flushAll(state), FLUSH_INTERVAL_MS);
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
 *  Exported (with underscore prefix) for the C2 regression test. */
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
  // Evict LRU when the cap is reached. C2: the victim is determined
  // by the explicit timestamp scan, not by Map iteration order.
  if (state.sessionBuffers.size >= MAX_BUFFER_SESSIONS) {
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
    // C3: translate the typed error into the existing response shape
    // so the public tool API is unchanged. Callers see
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
 *  plain objects are walked element-by-element. Used by M5 (checkpoint
 *  write) so secrets embedded in tool output are replaced with
 *  `[REDACTED:<category>]` markers BEFORE the JSONL line is written. */
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

    if (buf.length >= FLUSH_THRESHOLD) {
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

          // C3: catch the typed error and degrade gracefully — the
          // auto-restore hook is best-effort and must not break the
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

          // C3: same catch for readToolCalls.
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
  /** Phase-1 HIGH migration (E1): max checkpoint file size in bytes.
   *  Files larger than this are rejected. Defaults to 10 MiB. */
  maxFileSize?: number;
  /** Phase-1 HIGH migration (E2): max messages restored per checkpoint.
   *  Defaults to 50. */
  maxRestoredMessages?: number;
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
  // Phase-1 HIGH migration (E1, E2): defaults match the prior hardcoded
  // values, so behavior is unchanged when no YAML is provided.
  const maxFileSize = config.maxFileSize ?? DEFAULT_MAX_CHECKPOINT_FILE_SIZE;
  const maxRestoredMessages = config.maxRestoredMessages ?? DEFAULT_MAX_RESTORED_MESSAGES;

  // Per-instance state (DLC: no shared state between plugins)
  const state: CheckpointBufferState = {
    sessionBuffers: new Map(),
    headersWritten: new Set(),
    flushTimer: null,
    dir,
  };

  const tool: CheckpointTool = {
    description: `F5' Checkpoint — session snapshot and resumability.
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
