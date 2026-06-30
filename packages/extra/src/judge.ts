// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge
// Real LLM-judge implementation: scores 3+ candidates on 3 criteria, picks winner.

import { createLogger, type RichPluginContext } from "@sffmc/shared";

const log = createLogger("extra-judge");

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

interface JudgeResponse {
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
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.5
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

// ---------------------------------------------------------------------------
// Prompt building
// ---------------------------------------------------------------------------

export const DEFAULT_RUBRIC =
  "Score each candidate 0-10 on correctness, completeness, and conciseness. Pick the winner with brief reasoning.";

export function buildJudgePrompt(candidates: string[], rubric: string): { system: string; user: string } {
  const candidateBlocks = candidates
    .map((text, i) => `Candidate #${i}:\n\`\`\`\n${text}\n\`\`\``)
    .join("\n\n");

  const system = `You are an expert judge evaluating candidate outputs. Use the following rubric:\n\n${rubric}`;

  const user = [
    `Evaluate the following ${candidates.length} candidate outputs.`,
    "",
    candidateBlocks,
    "",
    "For each candidate, score 0-10 on these three criteria:",
    "  - correctness: factual accuracy and absence of errors",
    "  - completeness: thoroughness, covers all aspects",
    "  - conciseness: no fluff, direct and to the point",
    "",
    "Output ONLY a JSON object with this exact structure (no other text):",
    "{",
    '  "scores": [',
    '    { "correctness": <0-10>, "completeness": <0-10>, "conciseness": <0-10> },',
    "    ... (one per candidate)",
    "  ],",
    '  "winner": <index of best candidate, 0-based>,',
    '  "reasoning": "<brief explanation of why this candidate won>"',
    "}",
  ].join("\n");

  return { system, user };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

export function parseJudgeResponse(raw: string, n: number): JudgeResponse | null {
  try {
    const json = extractJudgeJsonObject(raw);
    if (json === null) return null;
    const parsed = JSON.parse(json) as JudgeResponse;
    return validateJudgeResponseShape(parsed, n);
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
  n: number,
): JudgeResponse | null {
  if (!hasValidJudgeScores(parsed.scores, n)) return null;
  if (typeof parsed.winner !== "number" || parsed.winner < 0 || parsed.winner >= n) {
    return null;
  }
  if (typeof parsed.reasoning !== "string" || parsed.reasoning.trim().length === 0) {
    return null;
  }
  return {
    scores: parsed.scores,
    winner: parsed.winner,
    reasoning: parsed.reasoning.trim(),
  };
}

/** Validate the `scores` array: must be an Array of length `n`, each
 *  entry's correctness/completeness/conciseness must be a number in [0,10]. */
function hasValidJudgeScores(scores: unknown, n: number): scores is JudgeScore[] {
  if (!Array.isArray(scores) || scores.length !== n) return false;
  for (const s of scores) {
    if (
      typeof s.correctness !== "number" ||
      s.correctness < 0 ||
      s.correctness > 10 ||
      typeof s.completeness !== "number" ||
      s.completeness < 0 ||
      s.completeness > 10 ||
      typeof s.conciseness !== "number" ||
      s.conciseness < 0 ||
      s.conciseness > 10
    ) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// LLM judge call
// ---------------------------------------------------------------------------

async function callJudge(
  candidates: string[],
  rubric: string,
  model: string,
  ctx: RichPluginContext,
): Promise<{ response: JudgeResponse; latencyMs: number }> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("ctx.client.session.message() not available");
  }

  const { system, user } = buildJudgePrompt(candidates, rubric);

  const start = performance.now();

  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.2,
  });

  const latencyMs = Math.round(performance.now() - start);

  const text = response.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

  const parsed = parseJudgeResponse(text, candidates.length);
  if (!parsed) {
    throw new Error("judge parse failed");
  }

  return { response: parsed, latencyMs };
}

// ---------------------------------------------------------------------------
// Streaming LLM judge call — delegates to callJudge() and emits progress chunks
// ---------------------------------------------------------------------------

export async function callJudgeStream(
  candidates: string[],
  rubric: string,
  model: string,
  ctx: RichPluginContext,
  onChunk: (chunk: JudgeStreamChunk) => void,
): Promise<JudgeResult> {
  try {
    const { response, latencyMs } = await callJudge(candidates, rubric, model, ctx);

    onChunk({ type: "scores", scores: response.scores });
    onChunk({ type: "winner", winner: response.winner });
    onChunk({ type: "reasoning", reasoning: response.reasoning });
    onChunk({ type: "complete" });

    return {
      ok: true,
      scores: response.scores,
      winner: response.winner,
      reasoning: response.reasoning,
      model,
      latencyMs,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    onChunk({ type: "error", error: errMsg });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Auto-judge marker extraction
// ---------------------------------------------------------------------------

const JUDGE_MARKER = "<!-- EXTRA_JUDGE_CANDIDATES: ";

export function extractCandidatesFromMessages(
  messages: Array<{ role: string; content: string }>,
): string[] | null {
  for (const msg of messages) {
    if (typeof msg.content !== "string") continue;
    const idx = msg.content.indexOf(JUDGE_MARKER);
    if (idx === -1) continue;
    const start = idx + JUDGE_MARKER.length;
    const end = msg.content.indexOf(" -->", start);
    if (end === -1) continue;
    const json = msg.content.slice(start, end).trim();
    try {
      const parsed = JSON.parse(json) as string[];
      if (Array.isArray(parsed) && parsed.length >= 2) {
        return parsed;
      }
    } catch {
      // ignore parse errors, keep scanning
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Factory helpers
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
  if (!input || !Array.isArray(input.candidates)) {
    return { kind: "error", error: "missing or invalid candidates array" };
  }
  const { candidates } = input;
  if (candidates.length < MIN_MAX_CANDIDATES) {
    return {
      kind: "error",
      error: `at least ${MIN_MAX_CANDIDATES} candidates required`,
    };
  }
  if (candidates.length > maxCandidates) {
    return {
      kind: "error",
      error: `maximum ${maxCandidates} candidates allowed`,
    };
  }
  return { kind: "ok", candidates };
}

/** Fallback path when no LLM ctx is available: score each candidate by output
 *  length (a length-derived approximation) and pick the winner. `model` is
 *  the literal string `"heuristic"` and `latencyMs` is always 0. */
function runJudgeFallbackHeuristic(candidates: string[]): JudgeResult {
  const scores: JudgeScore[] = candidates.map((c) => ({
    correctness: Math.min(10, Math.round(c.length / 100)),
    completeness: Math.min(10, Math.round(c.length / 150)),
    conciseness: Math.min(10, Math.round(800 / (c.length + 1))),
  }));

  const winner = scores.reduce(
    (best, s, i) =>
      s.correctness + s.completeness + s.conciseness >
      scores[best].correctness + scores[best].completeness + scores[best].conciseness
        ? i
        : best,
    0,
  );

  return {
    ok: true,
    scores,
    winner,
    reasoning: "Fallback heuristic: scored by output length",
    model: "heuristic",
    latencyMs: 0,
  };
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
    `Scores: ${scores.map((s, i) => `#${i}: C=${s.correctness} M=${s.completeness} N=${s.conciseness}`).join(" | ")}`,
    `Model: ${model} (${latencyMs}ms)`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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
