// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Lifecycle hook creators.
// Extracted from checkpoint.ts (M-1 god-object refactor, Task 1.7).

import { createLogger } from "@sffmc/utilities";
import * as v from "valibot";

import { CURRENT_VERSION } from "./constants";
import { getOrCreateBuffer, flushSession } from "./buffer";
import { readHeader } from "./header";
import { readToolCallsShim } from "./reader";
import { RESTORE_MARKER, reconstructMessages, sanitizeValue } from "./restore";
import {
  CheckpointTooLargeError,
  JSONValueSchema,
  type CheckpointBufferState,
  type CheckpointHooks,
  type ToolCall,
} from "./types";

const log = createLogger("extra-checkpoint");

/** Create the `tool.execute.after` hook that buffers tool calls and
 *  triggers a synchronous flush when the buffer reaches
 *  `state.flushThreshold`. */
export function createToolExecuteAfterHook(
  state: CheckpointBufferState,
): NonNullable<CheckpointHooks["tool.execute.after"]> {
  return async (toolCtx, result) => {
    const call: ToolCall = {
      tool: toolCtx.tool,
      // Parse metadata as JSONValue before reading `args` so the inner
      // field is a known contract, not an `unknown` indexer hop.
      // SAFETY: v.parse closes the unknown-to-JSONValue boundary for result.metadata; the cast re-states the documented `{ args?: unknown } | null` shape for the optional args field
      args: result.metadata ? (v.parse(JSONValueSchema, result.metadata) as { args?: unknown } | null)?.args ?? {} : {},
      result: sanitizeValue(result.output ?? null),
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

/** Create the `experimental.chat.messages.transform` hook for
 *  auto-restore. Scans each user message for an `EXTRA_RESTORE` marker;
 *  when found, replaces the marker with the reconstructed tool-call
 *  history for the named session. Oversize errors are caught and
 *  degrade gracefully (marker stripped, no messages injected). */
export function createAutoRestoreHook(
  dir: string,
  maxFileSize: number,
  maxRestoredMessages: number,
): NonNullable<CheckpointHooks["experimental.chat.messages.transform"]> {
  return async (_input, data) => {
    for (let i = 0; i < data.messages.length; i++) {
      const msg = data.messages[i];
      // `content` is `string` per the ChatMessage contract; the previous
      // `typeof msg.content !== "string"` guard was redundant with the
      // type and is removed per the no-runtime-typeof rule.
      const match = msg.content.match(RESTORE_MARKER);
      if (match) {
        const sessionID = match[1];
        log.info(
          `[extra] checkpoint auto-restore: loading session ${sessionID}`,
        );

        // Oversize error: catch the typed error and degrade gracefully
        // — the auto-restore hook is best-effort and must not break the
        // chat pipeline. Strip the marker and continue.
        let header: ReturnType<typeof readHeader>;
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
          calls = readToolCallsShim(sessionID, dir, maxFileSize);
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