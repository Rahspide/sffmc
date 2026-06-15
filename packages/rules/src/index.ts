import {
  loadRules,
  watchRules,
  parseRules,
  isPanicMode,
  type Rules,
} from "./rules";
import { evaluate } from "./gate";
import { type PluginContext } from "@sffmc/shared";
import { existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const DEFAULT_RULES_YAML = `version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: glob }
    action: allow
  - match: { tool: grep }
    action: allow
  - match: { tool: list }
    action: allow
  - match: { tool: write }
    action: allow
  - match: { tool: edit }
    action: allow
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: edit
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf /|chmod -R 777 /|mkfs\\\\."
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf|chmod 777|chmod -R|dd if=|mkfs|DROP TABLE|TRUNCATE|git push --force|git reset --hard|>|sudo "
    action: ask
`;

interface PluginState {
  rules: Rules;
  watcher: { stop: () => void } | null;
}

const server = async (ctx: PluginContext) => {
  const configPath = resolve(homedir(), ".config/SFFMC/rules.yaml");

  let rules: Rules;
  try {
    rules = loadRules(configPath);
    if (rules.rules.length === 0 && !existsSync(configPath)) {
      rules = parseRules(DEFAULT_RULES_YAML);
    }
  } catch {
    rules = parseRules(DEFAULT_RULES_YAML);
  }

  const state: PluginState = {
    rules,
    watcher: null,
  };

  try {
    state.watcher = watchRules(configPath, (newRules: Rules) => {
      state.rules = newRules;
    });
  } catch {
    // watcher failed to start — static rules only
  }

  return {
    "tool.execute.before": async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      args: { args: Record<string, unknown> },
    ) => {
      if (isPanicMode()) {
        throw new Error(
          "[F2 Rules] PANIC MODE: all tool calls denied. Fix ~/.config/SFFMC/rules.yaml syntax.",
        );
      }

      const result = evaluate(
        state.rules,
        toolCtx.tool,
        args.args,
        ctx.projectRoot,
      );

      if (result.action === "deny") {
        throw new Error(`[F2 Rules] DENIED: ${result.reason}`);
      }

      if (result.action === "ask") {
        console.warn(
          `[F2 Rules] WARNING: ${result.reason} — user confirmation needed`,
        );
      }
    },

    "permission.ask": async (
      perm: { tool?: string; name?: string; args?: Record<string, unknown> },
      status: { status: string },
    ) => {
      if (isPanicMode()) {
        status.status = "deny";
        return;
      }

      const toolName = perm?.tool || perm?.name || "";
      const result = evaluate(
        state.rules,
        toolName,
        perm?.args,
        ctx.projectRoot,
      );

      if (result.action === "deny") {
        status.status = "deny";
      }
    },
  };
};

export default {
  id: "@sffmc/rules",
  server,
};
