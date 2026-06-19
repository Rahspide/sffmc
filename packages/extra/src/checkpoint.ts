// SPDX-License-Identifier: MIT
// @sffmc/extra — F5' Checkpoint
// Real implementation: session state capture, persistence to JSONL, restore.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLogger } from "@sffmc/shared";

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

const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 5_000;
export const CURRENT_VERSION = 1;

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

function readHeader(sessionID: string, dir?: string): CheckpointHeader | null {
  const fp = filePath(sessionID, dir);
  if (!existsSync(fp)) return null;

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

export function readToolCalls(sessionID: string, dir?: string): ToolCall[] {
  const fp = filePath(sessionID, dir);

  // Single read into a buffer — no upfront existsSync/stat call.
  // ENOENT (missing file) and other read errors are handled by the catch.
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

interface CheckpointBufferState {
  sessionBuffers: Map<string, ToolCall[]>;
  headersWritten: Set<string>;
  flushTimer: ReturnType<typeof setInterval> | null;
  dir: string;
}

function _flushSession(state: CheckpointBufferState, sessionID: string): void {
  const buf = state.sessionBuffers.get(sessionID);
  if (!buf || buf.length === 0) return;

  ensureDir(state.dir);

  if (!state.headersWritten.has(sessionID)) {
    writeHeader(sessionID, state.dir);
    state.headersWritten.add(sessionID);
  }

  const fp = filePath(sessionID, state.dir);
  for (const tc of buf) {
    appendFileSync(fp, JSON.stringify(tc) + "\n");
  }

  buf.length = 0;
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

function _getOrCreateBuffer(state: CheckpointBufferState, sessionID: string): ToolCall[] {
  let buf = state.sessionBuffers.get(sessionID);
  if (!buf) {
    buf = [];
    state.sessionBuffers.set(sessionID, buf);
  }
  return buf;
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
function _executeRestoreAction(sessionID: string | undefined, dir: string): unknown {
  if (!sessionID) {
    return { ok: false, error: "sessionID is required for restore" };
  }

  const header = readHeader(sessionID, dir);
  if (!header) {
    return { ok: false, error: "checkpoint not found" };
  }

  if (header.version > CURRENT_VERSION) {
    return {
      ok: false,
      error: `unknown checkpoint version: ${header.version} (current: ${CURRENT_VERSION})`,
    };
  }

  const calls = readToolCalls(sessionID, dir);
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
      result: result.output,
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

        const header = readHeader(sessionID, dir);
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

        const calls = readToolCalls(sessionID, dir);
        const restored = reconstructMessages(calls);

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

export function createCheckpointTool(config: { enabled: boolean; dir?: string }): {
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
          return _executeRestoreAction(sessionID, dir);
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

    hooks["experimental.chat.messages.transform"] = _createAutoRestoreHook(dir);

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
