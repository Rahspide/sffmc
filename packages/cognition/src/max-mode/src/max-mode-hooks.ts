// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { createLogger, MAX_COMMAND } from "@sffmc/utilities";
import type { RichPluginContext } from "@sffmc/utilities";
import { generateCandidates } from "./candidates";
import { judgeCandidates } from "./judge";
import { resetRestoreState } from "./restore";
import {
  estimateCost,
  type PluginState,
} from "./max-mode-config";
import { buildWinnerMessage, consumeWinnerResult } from "./max-mode-winner";

const log = createLogger("max-mode");

/**
 * Build the hook handler bag for max-mode. Each handler closes over
 * `state` (per-instance) and `ctx` (plugin context). The handlers
 * decide whether to run, run candidates+judge+winner, and stash the
 * formatted message for the chat transforms to inject.
 */
export function createMaxModeHooks(
  state: PluginState,
  ctx: RichPluginContext,
) {
  const config = state.config;

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
}
