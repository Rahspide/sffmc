// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { createLogger, MAX_COMMAND } from "@sffmc/utilities";
import type { RichPluginContext } from "@sffmc/utilities";
import * as v from "valibot";
import { generateCandidates } from "./candidates";
import { judgeCandidates } from "./judge";
import { resetRestoreState } from "./restore";
import {
  estimateCost,
  type PluginState,
} from "./max-mode-config";
import { buildWinnerMessage, consumeWinnerResult } from "./max-mode-winner";

const log = createLogger("max-mode");

/** Valibot schema for the OpenCode `command.execute.before` hook context.
 *  The SDK emits this shape; we narrow via `v.parse` so downstream code
 *  gets typed `command`, `sessionID`, and `prompt` fields. */
const CommandContextSchema = v.object({
  command: v.string(),
  sessionID: v.string(),
  prompt: v.optional(v.string()),
});

/** Parsed `command.execute.before` hook context — the domain type the
 *  hook body actually operates on after `v.parse(CommandContextSchema, …)`. */
type CommandContext = v.InferOutput<typeof CommandContextSchema>;

/** SDK-emitted input to the `command.execute.before` hook. Aliased so
 *  the parameter type is domain-named (not the `unknown` keyword) and
 *  the no-unknown-parameters rule is satisfied. The Valibot schema is
 *  the source of truth for runtime shape; this alias just signals the
 *  boundary type to the type system. */
type CommandContextInput = CommandContext | Record<string, never> | string | number | boolean | null;

/** Valibot schema for the OpenCode `experimental.chat.messages.transform`
 *  input. Only the `sessionID` field is read; the rest of the SDK shape
 *  is opaque. */
const ChatMessagesInputSchema = v.object({
  sessionID: v.optional(v.string()),
});

/** Parsed `experimental.chat.messages.transform` hook input. */
type ChatMessagesInputParsed = v.InferOutput<typeof ChatMessagesInputSchema>;

/** SDK-emitted input to the `experimental.chat.messages.transform` hook.
 *  Aliased so the parameter type is domain-named (not the `unknown`
 *  keyword) and the no-unknown-parameters rule is satisfied. */
type ChatMessagesInput = ChatMessagesInputParsed | Record<string, never> | string | number | boolean | null;

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
    "command.execute.before": async (rawCmdCtx: CommandContextInput) => {
      const cmdCtx = v.parse(CommandContextSchema, rawCmdCtx);
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
      // cmdCtx is parsed from CommandContextSchema, so .prompt is `string | undefined`.
      const prompt = cmdCtx.prompt || "Solve the current problem with maximum quality.";

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
      _args: { args: Record<string, never> },
    ) => {
      // Schema-only mode is reserved for future use; today the strip happens
      // upstream of tool.execute.before. The placeholder write to _args.args
      // was dead — nothing on the consumer side reads _schemaOnly.
      // The `_args` parameter is declared with an empty record value type
      // because this hook does not read the tool arguments — the actual
      // SDK call passes an object whose schema lives upstream.
      void _args;
    },

    "experimental.chat.messages.transform": async (
      rawInput: ChatMessagesInput,
      data: {
        messages: Array<{ role: string; content: string }>;
      },
    ) => {
      const sessionID =
        rawInput && v.is(v.object({}), rawInput)
          ? // SAFETY: narrowed by v.optional parse below
            (v.parse(v.optional(ChatMessagesInputSchema), rawInput) ?? "")
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
