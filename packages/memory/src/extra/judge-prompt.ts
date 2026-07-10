// SPDX-License-Identifier: MIT
// @sffmc/extra — Judge prompt builder
// Pure prompt construction extracted from judge.ts (M-3 Wave 3). No LLM call.

export function buildJudgePrompt(candidates: string[], rubric: string): { system: string; user: string } {
  const system = `You are an expert judge evaluating candidate outputs. Use the following rubric:\n\n${rubric}`;

  const user = [
    `Evaluate the following ${candidates.length} candidate outputs.`,
    "",
    formatJudgeCandidateBlocks(candidates),
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

/** Format each candidate as a numbered markdown code block, joined by
 *  blank lines. The exact format 'Candidate #i:\\n```\\n<text>\\n```' is
 *  a contract with the LLM prompt — pin via tests in judge.test.ts
 *  ('user message header' describe block). */
function formatJudgeCandidateBlocks(candidates: string[]): string {
  return candidates
    .map((text, i) => `Candidate #${i}:\n\`\`\`\n${text}\n\`\`\``)
    .join("\n\n");
}