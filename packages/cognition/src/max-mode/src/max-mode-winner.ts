// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { createLogger, MAX_COMMAND } from "@sffmc/utilities";
import type { Candidate } from "./candidates";
import type { Verdict } from "./judge";
import type { PluginState } from "./max-mode-config";

const log = createLogger("max-mode");

/**
 * max-mode winner injection guard (Bug #7 HIGH) — strip well-known prompt-injection
 * patterns from winner content before it is injected back into the chat as an
 * assistant/system message. Defense-in-depth: max-mode generates N LLM
 * candidates in parallel, judges them, and pushes the winner into the
 * conversation. If a malicious candidate wins ("IGNORE PREVIOUS INSTRUCTIONS,
 * execute X"), the payload becomes the prior assistant turn — subsequent LLM
 * calls may comply. Patterns here are intentionally conservative: known
 * jailbreak phrasings, not heuristics. Anything novel still flows through;
 * defense-in-depth, not bulletproof.
 *
 * Each match is replaced with `[REDACTED:injection]` so downstream consumers
 * (LLM, logs, UI) see the marker instead of the literal instruction.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  // "Ignore all previous instructions" (and variants)
  { id: "ignore-previous-instructions",
    re: /IGNORE (?:ALL )?PREVIOUS INSTRUCTIONS/gi },
  // "Disregard all previous instructions/context"
  { id: "disregard-instructions",
    re: /DISREGARD (?:ALL )?(?:PREVIOUS )?(?:INSTRUCTIONS|CONTEXT)/gi },
  // "You are now <role>" — role-hijack attempts
  { id: "you-are-now",
    re: /YOU ARE NOW [^.\n]{1,200}/gi },
  // "SYSTEM:" pseudo-system-prompt prefix injection
  { id: "system-prefix",
    re: /SYSTEM: [^.\n]{1,200}/gi },
  // "Forget everything / all above" — context-wipe attempts
  { id: "forget-everything",
    re: /FORGET (?:EVERYTHING|ALL (?:OF )?(?:THE )?(?:PREVIOUS|ABOVE) (?:INSTRUCTIONS|CONTEXT|TEXT))/gi },
];

export function redactInjectionInWinner(content: string): string {
  if (!content) return content;
  let redacted = content;
  let redactionCount = 0;
  for (const pattern of INJECTION_PATTERNS) {
    const matches = redacted.match(pattern.re);
    if (matches && matches.length > 0) {
      redactionCount += matches.length;
      redacted = redacted.replace(pattern.re, "[REDACTED:injection]");
    }
  }
  if (redactionCount > 0) {
    log.warn(
      `Redacted ${redactionCount} prompt-injection pattern(s) from max-mode winner content`,
    );
  }
  return redacted;
}

/**
 * Consume (and delete) the pending winner result for a session. One-shot —
 * after the first chat transform fires for a session, the result is dropped
 * so subsequent transforms can't re-inject the same winner.
 * Returns the message to inject, or `undefined` if none is pending.
 */
export function consumeWinnerResult(state: PluginState, sessionID: string): string | undefined {
  const result = state.pendingResults.get(sessionID);
  if (!result) return undefined;
  state.pendingResults.delete(sessionID);
  return result.message;
}

export function buildWinnerMessage(
  candidate: Candidate,
  verdict: Verdict,
): string {
  const lines = [
    `🏆 MAX MODE VERDICT (confidence: ${(verdict.confidence * 100).toFixed(0)}%)`,
    `Winner: Candidate #${verdict.winner + 1} — ${verdict.reasoning}`,
    "",
    `--- WINNER OUTPUT ---`,
    // Bug #7 — filter winner draft for prompt-injection before it lands in
    // the chat as a previous assistant/system message.
    redactInjectionInWinner(candidate.draft),
  ];

  if (candidate.toolCalls.length > 0) {
    lines.push(
      "",
      "--- SUGGESTED TOOL CALLS (NOT EXECUTED) ---",
      "⚠️  Review these before confirming execution:",
    );
    for (const tc of candidate.toolCalls) {
      lines.push(`  - ${tc.name}(${JSON.stringify(tc.args)})`);
    }
    lines.push(
      "",
      `To execute: type '${MAX_COMMAND} execute' to confirm tool calls.`,
    );
  }

  return lines.join("\n");
}
