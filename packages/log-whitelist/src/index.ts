import { filterLines } from "./filter";
import { loadConfig, type PluginContext } from "@sffmc/shared";

interface LogWhitelistConfig {
  whitelist: string[];
  blacklist: string[];
  max_kept_lines: number;
  truncate_marker: string;
  log_filtered_count: boolean;
  suppress_patterns: string[];
}

const defaultConfig: LogWhitelistConfig = {
  whitelist: [],
  blacklist: [],
  max_kept_lines: 50,
  truncate_marker: "... [N more lines]",
  log_filtered_count: true,
  suppress_patterns: [],
};

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
  suppressPatterns: RegExp[];
  totalFiltered: number;
}

export const id = "@sffmc/log-whitelist"
export const server = async (_ctx: PluginContext) => {
  const config = await loadConfig<LogWhitelistConfig>("log-whitelist", defaultConfig);

  const state: PluginState = {
    config,
    whitelist: compilePatterns(config.whitelist),
    blacklist: compilePatterns(config.blacklist),
    suppressPatterns: compilePatterns(config.suppress_patterns),
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
        state.suppressPatterns,
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
        state.suppressPatterns,
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

export default { id, server }
