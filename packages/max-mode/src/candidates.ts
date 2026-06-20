import { type RichPluginContext } from "@sffmc/shared";

/** Hard cap on the number of parallel LLM candidates. Prevents users
 *  from setting n_candidates to very high values (e.g. 100) which would
 *  fire that many simultaneous API calls, exhausting quotas and budget.
 *
 *  H6 (Manriel audit, v0.14.2) — decision and rationale:
 *
 *  Manriel's original design used a cap of 50 candidates. The current
 *  code uses 10. Manriel's audit pushed back: "50 is intentional API
 *  behavior for max-mode parallel candidates, capping at 10 breaks
 *  the design."
 *
 *  Decision: KEEP the default at 10 (now configurable via
 *  `MaxModeConfig.maxCandidates`, see .slim/deepwork/phase-2-3-
 *  hardcode-migration-plan.md §2.6 — X1). Rationale:
 *
 *  1. Budget protection is the primary constraint. Each candidate is
 *     a separate `session.message()` call — the LLM API charges per
 *     call AND per token. With 50 candidates on a 1k-token prompt,
 *     one dream cycle burns ~50k tokens plus the multiplier for
 *     `temperature` variance. Most users run max-mode interactively
 *     and want a fast first response; 10 candidates at
 *     `temperature=1.0` already produces 10 distinct drafts to judge
 *     from.
 *
 *  2. The judge step (`judgeCandidates` in judge.ts) reads ALL
 *     candidate drafts into a single prompt. 50 candidates × 1k-token
 *     draft = 50k-token judge prompt, which exceeds most model
 *     context windows and forces truncation. 10 candidates keeps the
 *     judge prompt manageable.
 *
 *  3. The 50-candidate design assumes an offline / batch workflow
 *     with relaxed latency. The interactive workflow (which is the
 *     primary use case for max-mode in MiMo-Code) cannot wait for
 *     50 sequential LLM round-trips before showing the first result.
 *
 *  4. The cap is enforced at `Math.min(config.n, config.maxCandidates
 *     ?? 10)` (below). Callers that want more candidates can request
 *     them; the runtime clamps to the configured cap (default 10).
 *     This is a deliberate budget guard, not a bug.
 *
 *  v0.14.3 (Phase 2 — X1): the prior module-level `MAX_CANDIDATES = 10`
 *  was replaced with a `MaxModeConfig.maxCandidates` field. The default
 *  of 10 is preserved in `defaultConfig.maxCandidates`, so behavior is
 *  unchanged when no `~/.config/SFFMC/max-mode.yaml` is present.
 *
 *  See also: judge.ts (verdict selection across candidates) and
 *  restore.ts (tool execution after verdict).
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id: string;
}

export interface Candidate {
  id: string;
  temperature: number;
  draft: string;
  toolCalls: ToolCall[];
  tokens: number;
}

interface GenerateConfig {
  n: number;
  models: string[];
  temperature: number;
  /** X1 — Phase-2 MEDIUM migration. Hard cap on parallel LLM
   *  candidates. Optional so callers can omit it; safety cap falls
   *  back to 10 (matching the v0.14.2 module-level const). Callers
   *  built on `MaxModeConfig` always pass `config.maxCandidates`. */
  maxCandidates?: number;
}

export function buildCandidatePrompt(
  userPrompt: string,
  candidateIndex: number,
  totalCandidates: number,
): Array<{ role: string; content: string }> {
  return [
    {
      role: "system",
      content: [
        `You are Candidate #${candidateIndex + 1} of ${totalCandidates} solving a problem.`,
        `Generate your best solution.`,
        `You may suggest tool calls, but they will NOT be executed — they are for review only.`,
        `Be thorough and complete. Output your full reasoning and final answer.`,
      ].join("\n"),
    },
    {
      role: "user",
      content: userPrompt,
    },
  ];
}

export async function generateCandidates(
  prompt: string,
  config: GenerateConfig,
  ctx: RichPluginContext,
): Promise<Candidate[]> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("[max-mode] SDK client.session.message() not available");
  }

  const model = config.models[0] || String(ctx.config?.model || "");
  const candidates: Candidate[] = [];
  // X1 — Phase-2 MEDIUM migration. Safety cap: clamp requested n to the
  // configured maxCandidates (default 10, matching v0.14.2 const). This
  // is the deliberate budget guard — see block comment above.
  const n = Math.min(config.n, config.maxCandidates ?? 10);

  const messages = buildCandidatePrompt(prompt, 0, n);
  const requests = Array.from({ length: n }, (_, i) =>
    session.message!({
      messages: buildCandidatePrompt(prompt, i, n),
      model,
      temperature: config.temperature,
    }),
  );

  const results = await Promise.allSettled(requests);

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === "rejected") {
      candidates.push({
        id: `candidate-${i}`,
        temperature: config.temperature,
        draft: `[ERROR] Candidate ${i + 1} failed: ${String(result.reason)}`,
        toolCalls: [],
        tokens: 0,
      });
      continue;
    }

    const response = result.value;
    const textParts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const part of response.content) {
      if (part.type === "text" && part.text) {
        textParts.push(part.text);
      } else if (part.type === "toolCall" && part.toolCall) {
        toolCalls.push({
          name: part.toolCall.name,
          args: part.toolCall.args || {},
          id: part.toolCall.id,
        });
      }
    }

    candidates.push({
      id: `candidate-${i}`,
      temperature: config.temperature,
      draft: textParts.join("\n"),
      toolCalls,
      tokens: response.usage?.totalTokens ?? 0,
    });
  }

  return candidates;
}
