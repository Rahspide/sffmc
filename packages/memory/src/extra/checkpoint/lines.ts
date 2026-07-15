// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

// Body-line iterator with byte-offset seek.
// Extracted from the inline loop in `readToolCalls` (M-1 god-object
// refactor, Task 1.7).
//
// The v2 on-disk layout stores each ToolCall as one JSONL line, and the
// header carries `lineOffsets: number[]` — the byte offset of each line
// from start of file. This module encapsulates the per-line seek + parse
// loop so it can be tested independently of the surrounding `readHeader`
// migration / oversize-handling logic.

import type { ToolCall } from "./types";
import { createLogger } from "@sffmc/utilities";

const log = createLogger("extra-checkpoint");

/** Result of a single line iteration. `null` means "skip this line"
 *  (header, malformed JSON, missing required fields). The caller
 *  collects the non-null entries into the returned `ToolCall[]`. */
export type ParsedLine = ToolCall | null;

/** Iterate v2 body lines using the byte offsets stored in the header.
 *
 *  - `fileBuf` is the full checkpoint file as a Buffer.
 *  - `lineOffsets` is the header's `lineOffsets` array (byte offsets
 *    of each body line from file start).
 *  - Out-of-range offsets are skipped silently (defensive: an on-disk
 *    file with a corrupt offset index must not crash the reader).
 *  - Lines whose JSON does not match the ToolCall shape are skipped.
 *  - Lines whose first JSON field is `__type === "header"` are skipped
 *    (defensive: a duplicate header line is unexpected but harmless).
 *
 *  The returned array preserves the on-disk order. */
export function iterateBodyLines(
  fileBuf: Buffer,
  lineOffsets: number[],
): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; i < lineOffsets.length; i++) {
    const start = lineOffsets[i];
    if (typeof start !== "number" || start < 0 || start >= fileBuf.length) continue;
    // Locate the line terminator (LF) starting at `start`.
    let lineEnd = fileBuf.indexOf(0x0a, start);
    if (lineEnd < 0) lineEnd = fileBuf.length;
    const lineBytes = fileBuf.subarray(start, lineEnd);
    try {
      const obj = JSON.parse(lineBytes.toString("utf-8")) as Record<string, unknown>;
      if (obj.__type === "header") continue;
      if (
        typeof obj.tool === "string" &&
        typeof obj.timestamp === "number" &&
        typeof obj.callID === "string"
      ) {
        calls.push(obj as unknown as ToolCall);
      }
    } catch (e) {
      log.debug({ err: e, lineIndex: i }, "checkpoint-lines: skipping malformed line")
      // Skip malformed lines
    }
  }
  return calls;
}