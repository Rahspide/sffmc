import { filterLines } from "./filter";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface LogWhitelistConfig {
  whitelist: string[];
  blacklist: string[];
  max_kept_lines: number;
  truncate_marker: string;
  log_filtered_count: boolean;
}

const defaultConfig: LogWhitelistConfig = {
  whitelist: [],
  blacklist: [],
  max_kept_lines: 50,
  truncate_marker: "... [N more lines]",
  log_filtered_count: true,
};

function loadConfig(): LogWhitelistConfig {
  const configPath = resolve(homedir(), ".config/SFFMC/log.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<LogWhitelistConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

function compilePatterns(strings: string[]): RegExp[] {
  return strings
    .filter((s) => s.length > 0)
    .map((s) => {
      try {
        return new RegExp(s);
      } catch {
        return new RegExp("");
      }
    })
    .filter((re) => re.source !== "");
}

interface PluginState {
  config: LogWhitelistConfig;
  whitelist: RegExp[];
  blacklist: RegExp[];
  totalFiltered: number;
}

interface PluginContext {
  projectRoot: string;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

const server = async (_ctx: PluginContext) => {
  const config = loadConfig();

  const state: PluginState = {
    config,
    whitelist: compilePatterns(config.whitelist),
    blacklist: compilePatterns(config.blacklist),
    totalFiltered: 0,
  };

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config loaded on startup
    },

    "tool.execute.after": async (
      _toolCtx: { tool: string; sessionID: string; callID: string },
      result: { title?: string; output?: unknown; metadata?: unknown },
    ) => {
      if (state.whitelist.length === 0) return;

      // Only filter string output
      const output = result.output;
      if (typeof output !== "string") return;

      const lines = output.split("\n");
      const { kept, dropped } = filterLines(
        lines,
        state.whitelist,
        state.blacklist,
        state.config.max_kept_lines,
        state.config.truncate_marker,
      );

      if (dropped > 0) {
        state.totalFiltered += dropped;
        result.output = kept.join("\n");

        if (state.config.log_filtered_count) {
          console.warn(
            `[log-whitelist] filtered ${dropped} lines (total: ${state.totalFiltered})`,
          );
        }
      }
    },

    "experimental.text.complete": async (
      _msgCtx: { sessionID: string; messageID: string; partID: string },
      data: { text: string },
    ) => {
      if (state.whitelist.length === 0) return;

      const lines = data.text.split("\n");
      const { kept, dropped } = filterLines(
        lines,
        state.whitelist,
        state.blacklist,
        state.config.max_kept_lines,
        state.config.truncate_marker,
      );

      if (dropped > 0) {
        state.totalFiltered += dropped;
        data.text = kept.join("\n");

        if (state.config.log_filtered_count) {
          console.warn(
            `[log-whitelist] filtered ${dropped} text lines (total: ${state.totalFiltered})`,
          );
        }
      }
    },
  };
};

export default {
  id: "@sffmc/log-whitelist",
  server,
};
