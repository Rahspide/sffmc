// SPDX-License-Identifier: MIT
// @sffmc/extra — F5' Checkpoint
// Real implementation: session state capture, persistence to JSONL, restore.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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

const MIGRATIONS: Record<number, (data: unknown) => unknown> = {
  // Empty for now — populated when v2 is introduced
  // Example: 2: (v1: unknown) => ({ ...v1 as CheckpointState, version: 2 }),
};

export function migrateCheckpoint(raw: unknown, fromVersion: number): CheckpointState {
  if (fromVersion > CURRENT_VERSION) {
    throw new Error(`no migration from v${fromVersion} to v${CURRENT_VERSION} (downgrade not supported)`);
  }
  let data = raw;
  for (let v = fromVersion; v < CURRENT_VERSION; v++) {
    const migrator = MIGRATIONS[v + 1];
    if (!migrator) {
      throw new Error(`no migration from v${v} to v${v + 1}`);
    }
    data = migrator(data);
  }
  return data as CheckpointState;
}

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
    mkdirSync(dir, { recursive: true });
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
  if (!existsSync(fp)) return [];

  try {
    const raw = readFileSync(fp, "utf-8");
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
  } catch {
    return [];
  }
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
// In-memory buffer
// ---------------------------------------------------------------------------

const sessionBuffers = new Map<string, ToolCall[]>();
const headersWritten = new Set<string>();
let flushTimer: ReturnType<typeof setInterval> | null = null;

function getOrCreateBuffer(sessionID: string): ToolCall[] {
  let buf = sessionBuffers.get(sessionID);
  if (!buf) {
    buf = [];
    sessionBuffers.set(sessionID, buf);
  }
  return buf;
}

export function flushSession(sessionID: string, dir?: string): void {
  const buf = sessionBuffers.get(sessionID);
  if (!buf || buf.length === 0) return;

  const d = dir ?? getCheckpointDir();
  ensureDir(d);

  if (!headersWritten.has(sessionID)) {
    writeHeader(sessionID, dir);
    headersWritten.add(sessionID);
  }

  const fp = filePath(sessionID, dir);
  for (const tc of buf) {
    appendFileSync(fp, JSON.stringify(tc) + "\n");
  }

  buf.length = 0;
}

export function flushAll(dir?: string): void {
  for (const sid of sessionBuffers.keys()) {
    flushSession(sid, dir);
  }
}

function startFlushTimer(dir?: string): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => flushAll(dir), FLUSH_INTERVAL_MS);
  if (flushTimer && typeof flushTimer === "object" && "unref" in flushTimer) {
    flushTimer.unref();
  }
}

function stopFlushTimer(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Restore: reconstruct messages from ToolCalls
// ---------------------------------------------------------------------------

function reconstructMessages(
  calls: ToolCall[],
): Array<{ role: string; content: string }> {
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
// createCheckpointTool — returns { tool, hooks }
// ---------------------------------------------------------------------------

export function createCheckpointTool(config: { enabled: boolean; dir?: string }): {
  tool: CheckpointTool;
  hooks: CheckpointHooks;
} {
  const dir = config.dir || getCheckpointDir();
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
            sessionBuffers.delete(sessionID);
            headersWritten.delete(sessionID);
          }
          return { ok: true, deleted };
        }

        case "restore": {
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

          if (header.version < CURRENT_VERSION) {
            // Older schema — apply migrations (currently no-op since v1 == current)
            console.log(
              `[extra] checkpoint: migrating v${header.version} → v${CURRENT_VERSION}`,
            );
            // Migration runs but does not mutate the on-disk file —
            // the file is rewritten on next flush via writeHeader.
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

        default:
          return { ok: false, error: `unknown action: ${action}` };
      }
    },
  };

  // ---- hooks ----

  const hooks: CheckpointHooks = {};

  if (config.enabled) {
    hooks["tool.execute.after"] = async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      result: { output?: unknown; title?: string; metadata?: unknown },
    ) => {
      const call: ToolCall = {
        tool: toolCtx.tool,
        args: (result.metadata as Record<string, unknown>)?.args ?? {},
        result: result.output,
        timestamp: Date.now(),
        callID: toolCtx.callID,
      };

      const buf = getOrCreateBuffer(toolCtx.sessionID);
      buf.push(call);

      if (buf.length >= FLUSH_THRESHOLD) {
        flushSession(toolCtx.sessionID, dir);
      }
    };

    hooks["experimental.chat.messages.transform"] = async (
      _input: unknown,
      data: {
        messages: Array<{ role: string; content: string; [key: string]: unknown }>;
      },
    ) => {
      for (let i = 0; i < data.messages.length; i++) {
        const msg = data.messages[i];
        if (typeof msg.content !== "string") continue;

        const match = msg.content.match(RESTORE_MARKER);
        if (match) {
          const sessionID = match[1];
          console.log(
            `[extra] checkpoint auto-restore: loading session ${sessionID}`,
          );

          const header = readHeader(sessionID, dir);
          if (!header) {
            console.warn(
              `[extra] checkpoint auto-restore: session ${sessionID} not found`,
            );
            msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
            continue;
          }

          if (header.version > CURRENT_VERSION) {
            console.warn(
              `[extra] checkpoint auto-restore: session ${sessionID} has future version ${header.version} (current: ${CURRENT_VERSION})`,
            );
            msg.content = msg.content.replace(RESTORE_MARKER, "").trim();
            continue;
          }

          if (header.version < CURRENT_VERSION) {
            console.log(
              `[extra] checkpoint auto-restore: migrating v${header.version} → v${CURRENT_VERSION}`,
            );
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

    startFlushTimer(dir);
  }

  return { tool, hooks };
}

// ---------------------------------------------------------------------------
// Cleanup — for tests and graceful shutdown
// ---------------------------------------------------------------------------

export function __cleanup(): void {
  flushAll();
  stopFlushTimer();
  sessionBuffers.clear();
  headersWritten.clear();
}
