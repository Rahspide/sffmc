import { generateCandidates, type Candidate } from "./candidates";
import { judgeCandidates, type Verdict } from "./judge";
import { createRestoreState, stripToolExecutes, restoreToolExecutes, isSchemaOnly } from "./restore";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

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
  judge_model: "claude-sonnet-4-20250514",
  budget_cap_multiplier: 5,
  dry_run: false,
};

function loadConfig(): MaxModeConfig {
  const configPath = resolve(homedir(), ".config/SFFMC/max-mode.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<MaxModeConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

interface PluginState {
  config: MaxModeConfig;
  restore: ReturnType<typeof createRestoreState>;
  maxUsedThisSession: boolean;
}

interface PluginContext {
  projectRoot: string;
  config: Record<string, unknown>;
  sessionID?: string;
  client?: {
    session?: {
      message?(params: {
        messages: Array<{ role: string; content: string }>;
        model: string;
        temperature: number;
        tools?: unknown[];
      }): Promise<{
        content: Array<{ type: string; text?: string; toolCall?: { name: string; args: Record<string, unknown>; id: string } }>;
        usage: { totalTokens: number };
      }>;
    };
  };
  [key: string]: unknown;
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
      "To execute: type '/max execute' to confirm tool calls.",
    );
  }

  return lines.join("\n");
}

export const id = "@sffmc/max-mode"
export const server = async (ctx: PluginContext) => {
  const config = loadConfig();
  const state: PluginState = {
    config,
    restore: createRestoreState(),
    maxUsedThisSession: false,
  };

  if (config.dry_run) {
    console.warn("[max-mode] dry_run=true — Max Mode will only estimate costs");
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config loaded on startup
    },

    "command.execute.before": async (
      cmdCtx: { command: string; sessionID: string; [key: string]: unknown },
    ) => {
      const cmd = cmdCtx.command.trim();

      if (!cmd.startsWith("/max")) return;

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
        console.warn("[max-mode] SDK client.session.message() not available — cannot run Max Mode");
        return;
      }

      state.maxUsedThisSession = true;

      // Extract prompt from context (the user message that triggered /max)
      const prompt = (cmdCtx as Record<string, unknown>).prompt as string
        || "Solve the current problem with maximum quality.";

      if (isDryRun || config.dry_run) {
        console.warn(`[max-mode] DRY RUN: would generate ${config.n_candidates} candidates using model ${config.candidate_models[0] || "default"} at temperature ${config.candidate_temperature}`);
        console.warn(`[max-mode] Estimated cost: ~${config.n_candidates}x single call (budget cap: ${config.budget_cap_multiplier}x)`);
        return;
      }

      const budgetCap = config.budget_cap_multiplier;
      console.warn(`[max-mode] Generating ${config.n_candidates} candidates (budget cap: ${budgetCap}x)...`);

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
        console.warn(`[max-mode] Generated ${candidates.length} candidates, ${totalCost} tokens`);

        const verdict = await judgeCandidates(
          candidates,
          config.judge_model,
          ctx,
        );

        const winner = candidates[verdict.winner];
        const message = buildWinnerMessage(winner, verdict);

        console.warn(`[max-mode] Winner: Candidate #${verdict.winner + 1}, confidence: ${(verdict.confidence * 100).toFixed(0)}%`);

        // Inject winner as system message via the command context
        // The actual injection depends on how the SDK exposes message manipulation
        // For now, store in a side-channel that can be picked up by chat transforms
        (ctx as Record<string, unknown>)._maxModeResult = {
          winner,
          verdict,
          message,
        };
      } catch (err) {
        console.warn(`[max-mode] Error: ${String(err)}`);
        state.maxUsedThisSession = false;
      }
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      data: { system: string[] },
    ) => {
      const result = (ctx as Record<string, unknown>)._maxModeResult as
        | { message: string }
        | undefined;
      if (result) {
        data.system.push(result.message);
        delete (ctx as Record<string, unknown>)._maxModeResult;
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
      const result = (ctx as Record<string, unknown>)._maxModeResult as
        | { message: string }
        | undefined;
      if (result) {
        data.messages.push({
          role: "assistant",
          content: result.message,
        });
        delete (ctx as Record<string, unknown>)._maxModeResult;
      }
      return data;
    },
  };
};

export default { id, server }
