import type { Candidate } from "./candidates";
import { type RichPluginContext } from "@sffmc/utilities";

export interface Verdict {
  winner: number;
  reasoning: string;
  confidence: number;
}

/**
 * Build the judge prompt from a list of candidates.
 *
 * max-mode chokidar migration —  release migration. The per-candidate draft
 * truncation length was a hardcoded `c.draft.slice(0, 8000)` literal; it
 * is now `judgeDraftMaxChars` (default 8000, matches the prior literal).
 * Configurable via `MaxModeConfig.judgeDraftMaxChars` in
 * `~/.config/SFFMC/max-mode.yaml`. See
 * .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.6.
 */
export function buildJudgePrompt(
  candidates: Candidate[],
  judgeDraftMaxChars: number = 8000,
): string {
  const drafts = candidates
    .map(
      (c, i) =>
        `### Candidate ${i}\n\`\`\`\n${c.draft.slice(0, judgeDraftMaxChars)}\n\`\`\`\n${c.toolCalls.length > 0 ? `Tool calls suggested: ${c.toolCalls.length}` : "No tool calls"}`,
    )
    .join("\n\n");

  return [
    "You are a judge selecting the best of N candidate responses.",
    "Evaluate each candidate on: correctness, completeness, clarity, practicality.",
    "",
    drafts,
    "",
    "Output ONLY a JSON object with:",
    '  "winner": <index of best candidate (0-based)>',
    '  "reasoning": "<brief explanation of why this candidate won>"',
    '  "confidence": <number 0-1, how confident you are in this verdict>',
    "",
    "Reply with just the JSON object, no other text.",
  ].join("\n");
}

export function parseVerdict(raw: string, candidateCount: number): Verdict | null {
  try {
    const trimmed = raw.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: { winner: number; reasoning: string; confidence: number } =
      JSON.parse(jsonMatch[0]);

    if (typeof parsed.winner !== "number" || parsed.winner < 0 || parsed.winner >= candidateCount) {
      return null;
    }
    if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) {
      return null;
    }
    if (typeof parsed.reasoning !== "string" || parsed.reasoning.length === 0) {
      return null;
    }

    return {
      winner: parsed.winner,
      reasoning: parsed.reasoning,
      confidence: parsed.confidence,
    };
  } catch {
    return null;
  }
}

function fallbackVerdict(candidates: Candidate[], fallbackConfidence: number = 0.3): Verdict {
  // Pick the candidate with the longest draft as a heuristic
  let best = 0;
  let maxLen = 0;
  for (let i = 0; i < candidates.length; i++) {
    if (candidates[i].draft.length > maxLen) {
      maxLen = candidates[i].draft.length;
      best = i;
    }
  }
  return {
    winner: best,
    reasoning: "Fallback: selected candidate with most detailed output",
    confidence: fallbackConfidence,
  };
}

export async function judgeCandidates(
  candidates: Candidate[],
  judgeModel: string,
  ctx: RichPluginContext,
  // max-mode chokidar migration —  release migration. Optional 4th arg so existing callers
  // (3-arg signature used in agentic/test/max-mode.test.ts) keep working
  // without modification. Default 8000 matches the prior literal.
  judgeDraftMaxChars: number = 8000,
  // max-mode dream integration —  release migration. Optional 5th arg for fallback confidence.
  // Default 0.3 matches the prior literal. Configurable via
  // MaxModeConfig.fallbackConfidence in ~/.config/SFFMC/max-mode.yaml.
  fallbackConfidence: number = 0.3,
): Promise<Verdict> {
  const session = ctx.client?.session;
  if (!session?.message) {
    return fallbackVerdict(candidates, fallbackConfidence);
  }

  const prompt = buildJudgePrompt(candidates, judgeDraftMaxChars);

  try {
    const response = await session.message({
      messages: [
        {
          role: "system",
          content: "You are a judge. Output only the requested JSON object.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      model: judgeModel,
      temperature: 0.1,
    });

    const text = response.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n");

    const verdict = parseVerdict(text, candidates.length);
    return verdict ?? fallbackVerdict(candidates, fallbackConfidence);
  } catch {
    return fallbackVerdict(candidates, fallbackConfidence);
  }
}
