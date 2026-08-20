// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge response parser
// Pure JSON extraction + shape validation extracted from judge.ts (M-3 Wave 3).
// No LLM call, no side effects, throws caught by parseJudgeResponse.

import type { JudgeResponse, JudgeScore } from "./judge-types.ts";
import { createLogger } from "@sffmc/utilities";
import * as v from "valibot";

const log = createLogger("extra-judge");

// Valibot schemas for the judge response. Scores are validated as
// exactly N entries (one per candidate) with each entry's three fields
// bounded in [0,10]. `v.pipe(v.number(), v.minValue(0), v.maxValue(10))`
// encodes the 0..10 cap directly; out-of-range values fail the parse and
// `parseJudgeResponse` returns null (preserving the prior behavior
// pinned by judge.test.ts "rejects response with out-of-range scores").
const BoundedScoreSchema = v.pipe(
  v.number(),
  v.minValue(0),
  v.maxValue(10),
);
const ScoreTripletSchema = v.object({
  correctness: BoundedScoreSchema,
  completeness: BoundedScoreSchema,
  conciseness: BoundedScoreSchema,
});

function judgeResponseSchema(candidateCount: number) {
  return v.object({
    scores: v.pipe(v.array(ScoreTripletSchema), v.length(candidateCount)),
    winner: v.number(),
    reasoning: v.string(),
  });
}

export function parseJudgeResponse(raw: string, candidateCount: number): JudgeResponse | null {
  try {
    const json = extractJudgeJsonObject(raw);
    if (json === null) return null;
    const parsed = v.parse(judgeResponseSchema(candidateCount), JSON.parse(json));
    if (!isValidWinnerIndex(parsed.winner, candidateCount)) return null;
    if (!hasNonEmptyReason(parsed.reasoning)) return null;
    return {
      // SAFETY: validated by judgeResponseSchema v.parse on line N — scores is the schema-typed JudgeScore[] field, cast re-states the array shape
      scores: parsed.scores as JudgeScore[],
      winner: parsed.winner,
      reasoning: parsed.reasoning.trim(),
    };
  } catch (e) {
    log.debug({ err: e }, "judge-parse: parseJudgeResponse failed (returning null)")
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

/** `winner` must be an integer in `[0, candidateCount)`. After parsing
 *  the JSON shape the value is already typed as `number` — the
 *  function only enforces the domain range. */
function isValidWinnerIndex(winner: number, candidateCount: number): boolean {
  return winner >= 0 && winner < candidateCount;
}

/** `reasoning` must be a non-empty string after trimming. After parsing
 *  the JSON shape the value is already typed as `string` — the function
 *  only enforces the non-empty domain rule. */
function hasNonEmptyReason(reasoning: string): boolean {
  return reasoning.trim().length > 0;
}