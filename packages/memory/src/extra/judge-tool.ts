// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge tool factory + auto-judge hook
// Orchestrator + factory extracted from judge.ts (M-3 Wave 3).
// Wires the LLM call, the stream variant, the fallback heuristic,
// and the experimental chat-messages transform hook.

import { createLogger } from "@sffmc/utilities";
import { callJudge, callJudgeStream } from "./judge-llm.ts";
import { extractCandidatesFromMessages } from "./judge-extract.ts";
import {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_RUBRIC,
  MAX_MAX_CANDIDATES,
  MIN_MAX_CANDIDATES,
  type JudgeConfig,
  type JudgeHooks,
  type JudgeInput,
  type JudgeScore,
  type JudgeTool,
  type JudgeExecuteResult,
  type JudgeResult,
} from "./judge-types.ts";

const log = createLogger("extra-judge");

export function createJudgeTool(
  config: JudgeConfig,
): { tool: JudgeTool; hooks: JudgeHooks } {
  const rubric = config.rubric || DEFAULT_RUBRIC;
  const maxCandidates = clampMaxCandidates(config.maxCandidates);

  const tool: JudgeTool = {
    description: `Judge — multi-criteria LLM judge for evaluating candidate outputs.
Status: ${config.enabled ? "enabled" : "disabled"}.
When enabled, scores candidates 0-10 on correctness, completeness, conciseness, picks winner with reasoning. Model: ${config.model}.
Set stream: true to receive partial results as they become available (useful for ${maxCandidates}+ candidates).`,

    parameters: {
      type: "object",
      properties: {
        candidates: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: maxCandidates,
        },
        rubric: { type: "string" },
      },
      required: ["candidates"],
    },

    execute: async (input?: JudgeInput): Promise<JudgeExecuteResult> => {
      if (!config.enabled) {
        log.info("[extra] judge: disabled, skipping");
        return { ok: true, skipped: true, reason: "feature disabled" };
      }

      const validated = validateJudgeInput(input, maxCandidates);
      if (validated.kind === "error") {
        return { ok: false, error: validated.error };
      }
      const { candidates } = validated;
      const effectiveRubric = (input?.rubric as string | undefined) || rubric;

      // Try LLM judge
      if (config.ctx?.client?.session?.message) {
        try {
          if (input?.stream) {
            return await callJudgeStream(
              candidates,
              effectiveRubric,
              config.model,
              config.ctx,
              (chunk) => {
                log.info(`[extra] judge stream: ${chunk.type}`, chunk);
              },
            );
          }

          const { response, latencyMs } = await callJudge(
            candidates,
            effectiveRubric,
            config.model,
            config.ctx,
          );
          return {
            ok: true,
            scores: response.scores,
            winner: response.winner,
            reasoning: response.reasoning,
            model: config.model,
            latencyMs,
          };
        } catch (err) {
          log.warn(`[extra] judge: LLM call failed: ${String(err)}`);
          return { ok: false, error: `judge call failed: ${String(err)}` };
        }
      }

      // No client available — fallback heuristic
      log.warn("[extra] judge: no LLM client available, using fallback heuristic");
      return runJudgeFallbackHeuristic(candidates);
    },
  };

  // -------------------------------------------------------------------------
  // Auto-judge hook (opt-in, default off)
  // -------------------------------------------------------------------------

  const hooks: JudgeHooks = {};

  if (config.judge_auto && config.ctx?.client?.session?.message) {
    hooks["experimental.chat.messages.transform"] = async (
      _input: unknown,
      data: { messages: Array<{ role: string; content: string }> },
    ): Promise<void> => {
      try {
        const candidates = extractCandidatesFromMessages(data.messages);
        if (!candidates) return data;

        const { response, latencyMs } = await callJudge(
          candidates,
          rubric,
          config.model,
          config.ctx!,
        );

        const verdictMsg = formatJudgeVerdict(
          response.winner,
          response.reasoning,
          response.scores,
          config.model,
          latencyMs,
        );

        data.messages.push({
          role: "assistant",
          content: verdictMsg,
        });
      } catch (err) {
        log.warn(`[extra] judge auto-hook: ${String(err)}`);
      }
      return data;
    };
  }

  return { tool, hooks };
}

// ---------------------------------------------------------------------------
// Factory helpers (private — used only by createJudgeTool)
// ---------------------------------------------------------------------------

/** Clamp the configured `maxCandidates` to the documented 2-20 range. The
 *  floor keeps non-integer YAML values (e.g. 12.7 → 12) on integer grid.
 *  Replaces the previous hardcoded `maxItems: 8` and the matching runtime
 *  check `candidates.length > 8`. */
function clampMaxCandidates(rawMax: number | undefined): number {
  const raw = rawMax ?? DEFAULT_MAX_CANDIDATES;
  return Math.max(
    MIN_MAX_CANDIDATES,
    Math.min(MAX_MAX_CANDIDATES, Math.floor(raw)),
  );
}

/** Validate a `JudgeInput` against the `min`/`max` candidate bounds. Returns
 *  the validated `string[]` candidates on success, or an error description
 *  on failure. The caller maps the error into a `{ ok: false, error }`
 *  JudgeExecuteResult. */
function validateJudgeInput(
  input: JudgeInput | undefined,
  maxCandidates: number,
):
  | { kind: "ok"; candidates: string[] }
  | { kind: "error"; error: string } {
  if (!Array.isArray(input?.candidates)) {
    return { kind: "error", error: "missing or invalid candidates array" };
  }
  const { candidates } = input;
  const boundsError = validateCandidateBounds(candidates, maxCandidates);
  if (boundsError !== null) return { kind: "error", error: boundsError };
  return { kind: "ok", candidates };
}

/** Check the candidate-count bounds (≥ MIN_MAX_CANDIDATES and ≤ maxCandidates).
 *  Returns an error description string on failure, `null` on success.
 *  Kept separate so validateJudgeInput reads top-down: shape check →
 *  bounds check → ok. */
function validateCandidateBounds(
  candidates: string[],
  maxCandidates: number,
): string | null {
  if (candidates.length < MIN_MAX_CANDIDATES) {
    return `at least ${MIN_MAX_CANDIDATES} candidates required`;
  }
  if (candidates.length > maxCandidates) {
    return `maximum ${maxCandidates} candidates allowed`;
  }
  return null;
}

/** Fallback path when no LLM ctx is available: score each candidate by output
 *  length (a length-derived approximation) and pick the winner. `model` is
 *  the literal string `"heuristic"` and `latencyMs` is always 0. */
function runJudgeFallbackHeuristic(candidates: string[]): JudgeResult {
  const scores = candidates.map((c) => scoreCandidateByLength(c));
  const winner = pickHighestSumIndex(scores);
  return {
    ok: true,
    scores,
    winner,
    reasoning: "Fallback heuristic: scored by output length",
    model: "heuristic",
    latencyMs: 0,
  };
}

/** Score one candidate by its content length. The formulas are
 *  length-derived approximations — `correctness` scales with size up
 *  to a 1000-char cap, `completeness` scales with size up to a 1500-char
 *  cap, `conciseness` is the inverse (longer = less concise, also capped
 *  at 10). Each is clamped to [0,10] via `Math.min(10, Math.round(...))`.
 *  Pinned by judge.test.ts "scores each candidate on length-derived..."
 *  (line 710-729). */
function scoreCandidateByLength(c: string): JudgeScore {
  return {
    correctness: Math.min(10, Math.round(c.length / 100)),
    completeness: Math.min(10, Math.round(c.length / 150)),
    conciseness: Math.min(10, Math.round(800 / (c.length + 1))),
  };
}

/** Return the index of the entry whose correctness+completeness+conciseness
 *  sum is highest. Ties favor the earlier index (reduce starts at 0, only
 *  switches when the new entry's sum is STRICTLY greater). Pinned by
 *  judge.test.ts "winner is the index of the candidate with the highest
 *  sum of scores" (line 731-748). */
function pickHighestSumIndex(scores: JudgeScore[]): number {
  return scores.reduce(
    (best, s, i) =>
      s.correctness + s.completeness + s.conciseness >
      scores[best].correctness + scores[best].completeness + scores[best].conciseness
        ? i
        : best,
    0,
  );
}

/** Format a `JudgeResult` payload as the multi-line verdict string the
 *  auto-judge hook appends to `messages`. Pure: same inputs → same string. */
function formatJudgeVerdict(
  winner: number,
  reasoning: string,
  scores: JudgeScore[],
  model: string,
  latencyMs: number,
): string {
  return [
    `--- Judge Verdict ---`,
    `Winner: Candidate #${winner}`,
    `Reasoning: ${reasoning}`,
    `Scores: ${formatJudgeScoresLine(scores)}`,
    `Model: ${model} (${latencyMs}ms)`,
  ].join("\n");
}

/** Format the per-candidate scores line: '#i: C=<c> M=<m> N=<n>',
 *  joined by ' | '. Pinned by judge.test.ts "hook pushes a 'Judge Verdict'
 *  assistant message" (line 787-826) which checks the verdict content. */
function formatJudgeScoresLine(scores: JudgeScore[]): string {
  return scores
    .map((s, i) => `#${i}: C=${s.correctness} M=${s.completeness} N=${s.conciseness}`)
    .join(" | ");
}