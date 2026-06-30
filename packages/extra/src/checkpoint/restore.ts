// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Restore action + message reconstruction + secret redaction.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).

import { redactSecrets } from "@sffmc/shared";

import { CURRENT_VERSION } from "./constants.js";
import { readHeader } from "./header.js";
import { readToolCallsShim } from "./reader.js";
import { CheckpointTooLargeError } from "./types.js";
import type { ToolCall } from "./types.js";

/** Marker embedded in a user message to trigger auto-restore.
 *  Format: `<!-- EXTRA_RESTORE: <sessionID> -->` (whitespace tolerant). */
export const RESTORE_MARKER = /<!--\s*EXTRA_RESTORE:\s*(\S+)\s*-->/;

/** Reconstruct the chat messages that represent a sequence of tool
 *  calls. One assistant message per tool call. */
export function reconstructMessages(
  calls: ToolCall[],
): Array<{ role: "assistant"; content: string }> {
  return calls.map(
    (tc) => ({
      role: "assistant" as const,
      content: `Tool ${tc.tool}(${JSON.stringify(tc.args)}) → ${JSON.stringify(tc.result)}`,
    }),
  );
}

/** Execute the "restore" action — pure logic, no side effects beyond disk I/O. */
export function executeRestoreAction(
  sessionID: string | undefined,
  dir: string,
  maxFileSize: number,
): unknown {
  if (!sessionID) {
    return { ok: false, error: "sessionID is required for restore" };
  }

  let header: ReturnType<typeof readHeader>;
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
    calls = readToolCallsShim(sessionID, dir, maxFileSize);
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

/** Recursively walk an unknown value, redacting any string leaves via
 *  `redactSecrets`. Non-string primitives pass through unchanged. Arrays and
 *  plain objects are walked element-by-element. Used by the redaction rule
 *  for checkpoint writes so secrets embedded in tool output are replaced
 *  with `[REDACTED:<category>]` markers BEFORE the JSONL line is written. */
export function sanitizeResult(result: unknown): unknown {
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