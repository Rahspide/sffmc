import {
  loadRules,
  watchRules,
  parseRules,
  isPanicMode,
  compileRules,
  type Rules,
  type CompiledRule,
} from "./rules";
import { evaluate } from "./gate";
import { type PluginContext, createLogger, configHome } from "@sffmc/utilities";
import { existsSync } from "fs";
import { resolve } from "path";

const log = createLogger("rules");

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
  rules: CompiledRule[];
  watcher: { stop: () => void } | null;
}

export const id = "@sffmc/safety"
export const server = async (ctx: PluginContext) => {
  const configPath = resolve(configHome(), "SFFMC/rules.yaml");

  const initialRules = loadRulesWithFallback(configPath);

  // Pre-compile regex patterns once (and drop ReDoS-unsafe / invalid rules).
  // The compiled list is reused on every tool call — see bug #5a audit.
  const { rules: compiled } = compileRules(initialRules);

  const state: PluginState = {
    rules: compiled,
    watcher: null,
  };

  try {
    state.watcher = watchRules(configPath, (newRules: Rules) => {
      const { rules: recompiled } = compileRules(newRules);
      state.rules = recompiled;
    });
  } catch (e) {
    log.warn({ err: e, configPath }, "rules: watcher failed to start — using static rules only")
    // watcher failed to start — static rules only
  }

  return {
    "tool.execute.before": async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      args: { args: Record<string, unknown> },
    ) => {
      if (isPanicMode()) {
        throw new Error(
          "[Rules] PANIC MODE: all tool calls denied. Fix ~/.config/SFFMC/rules.yaml syntax.",
        );
      }

      const result = evaluate(
        state.rules,
        toolCtx.tool,
        args.args,
        ctx.projectRoot,
      );

      if (result.action === "deny") {
        throw new Error(`[Rules] DENIED: ${result.reason}`);
      }

      if (result.action === "ask") {
        log.warn(
          `[Rules] WARNING: ${result.reason} — user confirmation needed`,
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

/** Load rules from disk, falling back to the built-in defaults when the file
 *  is missing, unreadable, or produces an empty rule list. */
function loadRulesWithFallback(configPath: string): Rules {
  try {
    const fromDisk = loadRules(configPath);
    if (fromDisk.rules.length === 0 && !existsSync(configPath)) {
      return parseRules(DEFAULT_RULES_YAML);
    }
    return fromDisk;
  } catch (e) {
    log.warn({ err: e, configPath }, "rules: loadRulesWithFallback failed — using defaults")
    return parseRules(DEFAULT_RULES_YAML);
  }
}

export default { id, server }
