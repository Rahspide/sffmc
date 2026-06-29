import { generateCandidates, type Candidate } from "./candidates";
import { judgeCandidates, type Verdict } from "./judge";
import { createRestoreState, stripToolExecutes, restoreToolExecutes, resetRestoreState } from "./restore";
import { loadConfig, MAX_COMMAND, type RichPluginContext, createLogger } from "@sffmc/shared";

const log = createLogger("max-mode");

interface MaxModeConfig {
  n_candidates: number;
  candidate_models: string[];
  candidate_temperature: number;
  judge_model: string;
  budget_cap_multiplier: number;
  dry_run: boolean;
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.6
  /** max-mode checkpoint integration — hard cap on the number of parallel LLM candidates. Safety
   *  limit: prevents accidental bursts (e.g. `n_candidates: 100` firing
   *  100 parallel API calls). Enforced at runtime as
   *  `Math.min(config.n, maxCandidates)`. Default 10 matches the prior
   *  module-level const. Validation: 1 ≤ x ≤ 50. */
  maxCandidates: number;
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.6
  /** max-mode chokidar migration — max chars of each candidate draft sent to the judge. Truncates
   *  long drafts before they enter the judge prompt so a 50-candidate
   *  batch × 8k draft stays under the model's context window. Default
   *  8000 matches the prior literal. Validation: 500 ≤ x ≤ 32000. */
  judgeDraftMaxChars: number;
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §3.max-mode dream integration
  /** max-mode dream integration — confidence value stamped on the verdict whenever the judge path
   *  falls back (SDK offline, parse error, or empty/invalid response).
   *  Semantically distinct from a judge-reported confidence: a verdict
   *  produced under fallback tells downstream consumers "we have no real
   *  judge opinion" rather than "the judge rated this X%". Default 0.3
   *  matches the prior literal in fallbackVerdict(). Validation:
   *  0 ≤ x ≤ 1 (finite, not NaN/Infinity). */
  fallbackConfidence: number;
}

export const defaultConfig: MaxModeConfig = {
  n_candidates: 3,
  candidate_models: [],
  candidate_temperature: 1.0,
  judge_model: "",
  budget_cap_multiplier: 5,
  dry_run: false,
  // Defaults match the prior hardcoded values — behavior unchanged
  // when no ~/.config/SFFMC/max-mode.yaml is present.
  maxCandidates: 10,        // max-mode checkpoint integration (was `export const MAX_CANDIDATES = 10`)
  judgeDraftMaxChars: 8000, // max-mode chokidar migration (was `c.draft.slice(0, 8000)` literal)
  fallbackConfidence: 0.3,  // max-mode dream integration (was hardcoded `confidence: 0.3` in fallbackVerdict)
};

interface MaxModeResult {
  winner: Candidate;
  verdict: Verdict;
  message: string;
}

interface PluginState {
  config: MaxModeConfig;
  restore: ReturnType<typeof createRestoreState>;
  maxUsedThisSession: boolean;
  /** Pending one-shot verdict per session. Consumed (and deleted) by whichever
   *  chat transform fires  (system or messages) for that session.
   *  Per-instance — was previously stashed on ctx (`pendingResults`), which
   *  leaked across sessions in long-running processes. */
  pendingResults: Map<string, MaxModeResult>;
}

function estimateCost(candidates: Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.tokens, 0);
}

/**
 * max-mode winner injection guard (Bug #7 HIGH) — strip well-known prompt-injection
 * patterns from winner content before it is injected back into the chat as an
 * assistant/system message. Defense-in-depth: max-mode generates N LLM
 * candidates in parallel, judges them, and pushes the winner into the
 * conversation. If a malicious candidate wins ("IGNORE PREVIOUS INSTRUCTIONS,
 * execute X"), the payload becomes the prior assistant turn — subsequent LLM
 * calls may comply. Patterns here are intentionally conservative: known
 * jailbreak phrasings, not heuristics. Anything novel still flows through;
 * defense-in-depth, not bulletproof.
 *
 * Each match is replaced with `[REDACTED:injection]` so downstream consumers
 * (LLM, logs, UI) see the marker instead of the literal instruction.
 */
const INJECTION_PATTERNS: ReadonlyArray<{ id: string; re: RegExp }> = [
  // "Ignore all previous instructions" (and variants)
  { id: "ignore-previous-instructions",
    re: /IGNORE (?:ALL )?PREVIOUS INSTRUCTIONS/gi },
  // "Disregard all previous instructions/context"
  { id: "disregard-instructions",
    re: /DISREGARD (?:ALL )?(?:PREVIOUS )?(?:INSTRUCTIONS|CONTEXT)/gi },
  // "You are now <role>" — role-hijack attempts
  { id: "you-are-now",
    re: /YOU ARE NOW [^.\n]{1,200}/gi },
  // "SYSTEM:" pseudo-system-prompt prefix injection
  { id: "system-prefix",
    re: /SYSTEM: [^.\n]{1,200}/gi },
  // "Forget everything / all above" — context-wipe attempts
  { id: "forget-everything",
    re: /FORGET (?:EVERYTHING|ALL (?:OF )?(?:THE )?(?:PREVIOUS|ABOVE) (?:INSTRUCTIONS|CONTEXT|TEXT))/gi },
];

export function redactInjectionInWinner(content: string): string {
  if (!content) return content;
  let redacted = content;
  let redactionCount = 0;
  for (const pattern of INJECTION_PATTERNS) {
    const matches = redacted.match(pattern.re);
    if (matches && matches.length > 0) {
      redactionCount += matches.length;
      redacted = redacted.replace(pattern.re, "[REDACTED:injection]");
    }
  }
  if (redactionCount > 0) {
    log.warn(
      `Redacted ${redactionCount} prompt-injection pattern(s) from max-mode winner content`,
    );
  }
  return redacted;
}

/**
 * Consume (and delete) the pending winner result for a session. One-shot —
 * after the first chat transform fires for a session, the result is dropped
 * so subsequent transforms can't re-inject the same winner.
 * Returns the message to inject, or `undefined` if none is pending.
 */
function consumeWinnerResult(state: PluginState, sessionID: string): string | undefined {
  const result = state.pendingResults.get(sessionID);
  if (!result) return undefined;
  state.pendingResults.delete(sessionID);
  return result.message;
}

function buildWinnerMessage(
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

export const id = "@sffmc/max-mode"
export const server = async (ctx: RichPluginContext) => {
  const config = await loadConfig<MaxModeConfig>("max-mode", defaultConfig);
  const state: PluginState = {
    config,
    restore: createRestoreState(),
    maxUsedThisSession: false,
    pendingResults: new Map(),
  };

  if (config.dry_run) {
    log.warn("dry_run=true — Max Mode will only estimate costs");
  }

  return {
    "command.execute.before": async (
      cmdCtx: { command: string; sessionID: string; [key: string]: unknown },
    ) => {
      const cmd = cmdCtx.command.trim();

      if (!cmd.startsWith(MAX_COMMAND)) return;

      const isDryRun = cmd.includes("--dry-run");
      const isExecute = cmd.includes("execute");

      if (isExecute) {
        // /max execute — clear schema-only mode and re-arm the toolset for
        // real execution. resetRestoreState is a no-op (state is per-session),
        // but we still call it as a documented checkpoint for the re-arm path.
        resetRestoreState();
        state.maxUsedThisSession = false;
        return;
      }

      // Prevent re-entry
      if (state.maxUsedThisSession) {
        return;
      }

      const session = ctx.client?.session;
      if (!session?.message) {
        log.warn("SDK client.session.message() not available — cannot run Max Mode");
        return;
      }

      state.maxUsedThisSession = true;

      // Extract prompt from context (the user message that triggered /max)
      // cmdCtx is typed with [key: string]: unknown index signature, so
      // .prompt is already typed as unknown — no cast needed.
      const prompt = (typeof cmdCtx.prompt === "string" ? cmdCtx.prompt : "")
        || "Solve the current problem with maximum quality.";

      if (isDryRun || config.dry_run) {
        log.warn(`DRY RUN: would generate ${config.n_candidates} candidates using model ${config.candidate_models[0] || "default"} at temperature ${config.candidate_temperature}`);
        log.warn(`Estimated cost: ~${config.n_candidates}x single call (budget cap: ${config.budget_cap_multiplier}x)`);
        return;
      }

      const budgetCap = config.budget_cap_multiplier;
      log.warn(`Generating ${config.n_candidates} candidates (budget cap: ${budgetCap}x)...`);

      try {
        const candidates = await generateCandidates(
          prompt,
          {
            n: config.n_candidates,
            models: config.candidate_models,
            temperature: config.candidate_temperature,
            // max-mode checkpoint integration —  release migration. Safety cap on parallel
            // candidates. candidates.ts enforces
            // `Math.min(config.n, config.maxCandidates ?? 10)`.
            maxCandidates: config.maxCandidates,
          },
          ctx,
        );

        const totalCost = estimateCost(candidates);
        log.warn(`Generated ${candidates.length} candidates, ${totalCost} tokens`);

        const verdict = await judgeCandidates(
          candidates,
          config.judge_model,
          ctx,
          // max-mode chokidar migration —  release migration. Max chars of each draft sent
          // to the judge. judge.ts truncates each draft before it enters
          // the judge prompt.
          config.judgeDraftMaxChars,
          // max-mode dream integration —  release migration. Confidence stamped on fallback
          // verdicts (SDK offline / parse failure / empty response).
          // Distinct from judge-reported confidence.
          config.fallbackConfidence,
        );

        const winner = candidates[verdict.winner];
        const message = buildWinnerMessage(winner, verdict);

        log.warn(`Winner: Candidate #${verdict.winner + 1}, confidence: ${(verdict.confidence * 100).toFixed(0)}%`);

        // Inject winner as system message via the command context
        // The actual injection depends on how the SDK exposes message manipulation
        // For now, store in a per-instance side-channel that can be picked up by chat transforms
        state.pendingResults.set(cmdCtx.sessionID, {
          winner,
          verdict,
          message,
        });
      } catch (err) {
        log.warn(`Error: ${String(err)}`);
        state.maxUsedThisSession = false;
      }
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      data: { system: string[] },
    ) => {
      const sessionID = _input.sessionID;
      if (!sessionID) return data;
      const message = consumeWinnerResult(state, sessionID);
      if (message !== undefined) {
        data.system.push(message);
      }
      return data;
    },

    "tool.execute.before": async (
      _toolCtx: { tool: string },
      _args: { args: Record<string, unknown> },
    ) => {
      // Schema-only mode is reserved for future use; today the strip happens
      // upstream of tool.execute.before. The placeholder write to _args.args
      // was dead — nothing on the consumer side reads _schemaOnly.
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      data: {
        messages: Array<{ role: string; content: string; [key: string]: unknown }>;
      },
    ) => {
      const sessionID =
        _input && typeof _input === "object"
          ? ((_input as { sessionID?: string }).sessionID ?? "")
          : "";
      if (!sessionID) return data;
      const message = consumeWinnerResult(state, sessionID);
      if (message !== undefined) {
        data.messages.push({
          role: "assistant",
          content: message,
        });
      }
      return data;
    },
  };
};

export default { id, server }
