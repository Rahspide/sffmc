// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge response parser
// Pure JSON extraction + shape validation extracted from judge.ts (M-3 Wave 3).
// No LLM call, no side effects, throws caught by parseJudgeResponse.

import type { JudgeResponse, JudgeScore } from "./judge-types.ts";

export function parseJudgeResponse(raw: string, candidateCount: number): JudgeResponse | null {
  try {
    const json = extractJudgeJsonObject(raw);
    if (json === null) return null;
    const parsed = JSON.parse(json) as JudgeResponse;
    return validateJudgeResponseShape(parsed, candidateCount);
  } catch {
    return null;
  }
}

/** Extract the JSON object literal from a free-form LLM response. Handles
 *  markdown code fences, leading text, and trailing text — the regex
 *  matches the first `{...}` span. Returns `null` if no JSON object is
 *  found. */
function extractJudgeJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : null;
}

/** Validate the parsed JudgeResponse shape (scores / winner / reasoning).
 *  Returns the normalized response (with reasoning trimmed) on success,
 *  or `null` on any structural failure. The caller is responsible for the
 *  outer try/catch around `JSON.parse`. */
function validateJudgeResponseShape(
  parsed: JudgeResponse,
  candidateCount: number,
): JudgeResponse | null {
  if (!hasValidJudgeScores(parsed.scores, candidateCount)) return null;
  if (!isValidWinnerIndex(parsed.winner, candidateCount)) return null;
  if (!hasNonEmptyReason(parsed.reasoning)) return null;
  return {
    scores: parsed.scores,
    winner: parsed.winner,
    reasoning: parsed.reasoning.trim(),
  };
}

/** `winner` must be an integer in `[0, candidateCount)`. Used as the second gate
 *  in validateJudgeResponseShape after the scores array check. */
function isValidWinnerIndex(winner: unknown, candidateCount: number): winner is number {
  return typeof winner === "number" && winner >= 0 && winner < candidateCount;
}

/** `reasoning` must be a non-empty string after trimming. Used as the
 *  third gate in validateJudgeResponseShape. */
function hasNonEmptyReason(reasoning: unknown): reasoning is string {
  return typeof reasoning === "string" && reasoning.trim().length > 0;
}

/** Validate the `scores` array: must be an Array of length `candidateCount`, each
 *  entry's correctness/completeness/conciseness must be a number in [0,10]. */
function hasValidJudgeScores(scores: unknown, candidateCount: number): scores is JudgeScore[] {
  if (!Array.isArray(scores) || scores.length !== candidateCount) return false;
  for (const s of scores) {
    if (!isValidScoreTriplet(s)) return false;
  }
  return true;
}

/** Per-entry score validator: correctness, completeness, conciseness
 *  must each be a number in [0,10]. Pinned by judge.test.ts existing
 *  "scores 0-10 cap" test (line 710-729) on the fallback heuristic. */
function isValidScoreTriplet(s: unknown): s is JudgeScore {
  if (typeof s !== "object" || s === null) return false;
  const e = s as Partial<JudgeScore>;
  return (
    typeof e.correctness === "number" &&
    e.correctness >= 0 &&
    e.correctness <= 10 &&
    typeof e.completeness === "number" &&
    e.completeness >= 0 &&
    e.completeness <= 10 &&
    typeof e.conciseness === "number" &&
    e.conciseness >= 0 &&
    e.conciseness <= 10
  );
}