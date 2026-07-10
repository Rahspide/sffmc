// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

/**
 * Winner-message formatting + one-shot pending-result bookkeeping for the
 * max-mode plugin. These helpers operate purely on PluginState and Candidate
 * data — no SDK hooks, no plugin lifecycle — so they stay trivially testable
 * and can be reused (or replaced) without touching the plugin surface.
 */

import { MAX_COMMAND } from "@sffmc/utilities";
import { redactInjectionInWinner } from "./injection";
import type { Candidate } from "./candidates";
import type { Verdict } from "./judge";
import type { MaxModeResult, PluginState } from "./types-config";

export function estimateCost(candidates: Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.tokens, 0);
}

/**
 * Consume (and delete) the pending winner result for a session. One-shot —
 * after the first chat transform fires for a session, the result is dropped
 * so subsequent transforms can't re-inject the same winner.
 * Returns the message to inject, or `undefined` if none is pending.
 */
export function consumeWinnerResult(
  state: PluginState,
  sessionID: string,
): string | undefined {
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

export type { MaxModeResult };