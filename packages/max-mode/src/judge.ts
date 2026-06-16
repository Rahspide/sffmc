import type { Candidate } from "./candidates";
import { type RichPluginContext } from "@sffmc/shared"

export interface Verdict {
  winner: number;
  reasoning: string;
  confidence: number;
}

export function buildJudgePrompt(candidates: Candidate[]): string {
  const drafts = candidates
    .map(
      (c, i) =>
        `### Candidate ${i}\n\`\`\`\n${c.draft.slice(0, 8000)}\n\`\`\`\n${c.toolCalls.length > 0 ? `Tool calls suggested: ${c.toolCalls.length}` : "No tool calls"}`,
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

export function parseVerdict(raw: string, n: number): Verdict | null {
  try {
    const trimmed = raw.trim();
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed: { winner: number; reasoning: string; confidence: number } =
      JSON.parse(jsonMatch[0]);

    if (typeof parsed.winner !== "number" || parsed.winner < 0 || parsed.winner >= n) {
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

function fallbackVerdict(candidates: Candidate[]): Verdict {
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
    confidence: 0.3,
  };
}

export async function judgeCandidates(
  candidates: Candidate[],
  judgeModel: string,
  ctx: RichPluginContext,
): Promise<Verdict> {
  const session = ctx.client?.session;
  if (!session?.message) {
    return fallbackVerdict(candidates);
  }

  const prompt = buildJudgePrompt(candidates);

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
    return verdict ?? fallbackVerdict(candidates);
  } catch {
    return fallbackVerdict(candidates);
  }
}
