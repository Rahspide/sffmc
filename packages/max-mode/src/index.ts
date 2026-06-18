import { generateCandidates, type Candidate } from "./candidates";
import { judgeCandidates, type Verdict } from "./judge";
import { createRestoreState, stripToolExecutes, restoreToolExecutes, isSchemaOnly } from "./restore";
import { loadConfig, MAX_COMMAND, type RichPluginContext, createLogger } from "@sffmc/shared";

const log = createLogger("max-mode");

interface MaxModeConfig {
  n_candidates: number;
  candidate_models: string[];
  candidate_temperature: number;
  judge_model: string;
  budget_cap_multiplier: number;
  dry_run: boolean;
}

const defaultConfig: MaxModeConfig = {
  n_candidates: 3,
  candidate_models: [],
  candidate_temperature: 1.0,
  judge_model: "",
  budget_cap_multiplier: 5,
  dry_run: false,
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
   *  chat transform fires first (system or messages) for that session.
   *  Per-instance — was previously stashed on ctx (`_maxModeResult`), which
   *  leaked across sessions in long-running processes. */
  _maxModeResult: Map<string, MaxModeResult>;
}

function estimateCost(candidates: Candidate[]): number {
  return candidates.reduce((sum, c) => sum + c.tokens, 0);
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
    candidate.draft,
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
    _maxModeResult: new Map(),
  };

  if (config.dry_run) {
    log.warn("dry_run=true — Max Mode will only estimate costs");
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config loaded on startup
    },

    "command.execute.before": async (
      cmdCtx: { command: string; sessionID: string; [key: string]: unknown },
    ) => {
      const cmd = cmdCtx.command.trim();

      if (!cmd.startsWith(MAX_COMMAND)) return;

      const isDryRun = cmd.includes("--dry-run");
      const isExecute = cmd.includes("execute");

      if (isExecute) {
        restoreToolExecutes([], state.restore);
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
          },
          ctx,
        );

        const totalCost = estimateCost(candidates);
        log.warn(`Generated ${candidates.length} candidates, ${totalCost} tokens`);

        const verdict = await judgeCandidates(
          candidates,
          config.judge_model,
          ctx,
        );

        const winner = candidates[verdict.winner];
        const message = buildWinnerMessage(winner, verdict);

        log.warn(`Winner: Candidate #${verdict.winner + 1}, confidence: ${(verdict.confidence * 100).toFixed(0)}%`);

        // Inject winner as system message via the command context
        // The actual injection depends on how the SDK exposes message manipulation
        // For now, store in a per-instance side-channel that can be picked up by chat transforms
        state._maxModeResult.set(cmdCtx.sessionID, {
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
      const result = state._maxModeResult.get(sessionID);
      if (result) {
        data.system.push(result.message);
        state._maxModeResult.delete(sessionID);
      }
      return data;
    },

    "tool.execute.before": async (
      _toolCtx: { tool: string },
      _args: { args: Record<string, unknown> },
    ) => {
      if (isSchemaOnly(state.restore)) {
        // Schema-only mode: don't execute, just return placeholder
        _args.args = { ..._args.args, _schemaOnly: true };
      }
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
      const result = state._maxModeResult.get(sessionID);
      if (result) {
        data.messages.push({
          role: "assistant",
          content: result.message,
        });
        state._maxModeResult.delete(sessionID);
      }
      return data;
    },
  };
};

export default { id, server }
