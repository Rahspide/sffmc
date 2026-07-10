// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge types & constants
// Pure types/constants split from judge.ts (M-3 god-decomposition, Wave 3).
// No runtime logic, no LLM, no orchestration — just shapes + bounds.

import type { RichPluginContext } from "@sffmc/utilities";

// ---------------------------------------------------------------------------
// Public input/result types
// ---------------------------------------------------------------------------

export interface JudgeInput {
  candidates: string[];
  rubric?: string;
  stream?: boolean;
}

export interface JudgeScore {
  correctness: number; // 0-10
  completeness: number; // 0-10
  conciseness: number; // 0-10
}

export interface JudgeResult {
  ok: true;
  scores: JudgeScore[];
  winner: number;
  reasoning: string;
  model: string;
  latencyMs: number;
}

export interface JudgeError {
  ok: false;
  error: string;
}

export interface JudgeSkipped {
  ok: true;
  skipped: true;
  reason: string;
}

export type JudgeExecuteResult = JudgeResult | JudgeError | JudgeSkipped;

export interface JudgeStreamChunk {
  type: "scores" | "winner" | "reasoning" | "complete" | "error";
  /** For type="scores": array of partial scores (only some candidates scored so far) */
  scores?: Partial<JudgeScore>[];
  /** For type="winner": the candidate index */
  winner?: number;
  /** For type="reasoning": partial reasoning text */
  reasoning?: string;
  /** For type="error": error message */
  error?: string;
}

export interface JudgeTool {
  description: string;
  parameters: {
    type: "object";
    properties: {
      candidates: {
        type: "array";
        items: { type: "string" };
        minItems: number;
        maxItems: number;
      };
      rubric: { type: "string" };
    };
    required: string[];
  };
  execute: (input?: JudgeInput) => Promise<JudgeExecuteResult>;
}

export interface JudgeHooks {
  "experimental.chat.messages.transform"?: (
    input: unknown,
    data: { messages: Array<{ role: string; content: string }> },
  ) => Promise<void>;
}

// ---------------------------------------------------------------------------
// LLM response shape expected from the judge model
// ---------------------------------------------------------------------------

export interface JudgeResponse {
  scores: JudgeScore[];
  winner: number;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Config (judge-specific subset; full ExtraConfig lives in index.ts)
// ---------------------------------------------------------------------------

export interface JudgeConfig {
  enabled: boolean;
  model: string;
  rubric: string;
  /** Auto-judge hook: scan messages for EXTRA_JUDGE_CANDIDATES marker. Default false. */
  judge_auto?: boolean;
  /** PluginContext for LLM calls. Required for real judging. */
  ctx?: RichPluginContext;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §2.5
  /** judge prompt — max number of candidates the judge will accept per call. Also
   *  used as the JSON-Schema `maxItems` for the `candidates` parameter.
   *  Defaults to `DEFAULT_MAX_CANDIDATES` (8). Validated to the 2-20 range
   *  to protect the LLM context window. Raising this directly increases
   *  the per-judge LLM call size and latency (O(n) per candidate). */
  maxCandidates?: number;
}

/** Default max candidates per judge call (judge prompt). Overridable via
 *  `ExtraConfig.judge_max_candidates` (forwarded to
 *  `JudgeConfig.maxCandidates`). Range: 2-20 (clamped on assignment). */
export const DEFAULT_MAX_CANDIDATES = 8;
/** Lower bound for `JudgeConfig.maxCandidates` (judge prompt). */
export const MIN_MAX_CANDIDATES = 2;
/** Upper bound for `JudgeConfig.maxCandidates` (judge prompt). */
export const MAX_MAX_CANDIDATES = 20;

export const DEFAULT_RUBRIC =
  "Score each candidate 0-10 on correctness, completeness, and conciseness. Pick the winner with brief reasoning.";