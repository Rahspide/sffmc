import { filterLines } from "./filter";
import { loadConfig, type PluginContext, createLogger } from "@sffmc/utilities";
import safeRegex from "safe-regex";

const log = createLogger("log-whitelist");

interface LogWhitelistConfig {
  whitelist: string[];
  blacklist: string[];
  max_kept_lines: number;
  truncate_marker: string;
  log_filtered_count: boolean;
  suppress_patterns: string[];
}

/** Default cap on kept lines after filtering. Picked to fit comfortably in
 *  an LLM tool result without overflow. */
const DEFAULT_MAX_KEPT_LINES = 50;

const defaultConfig: LogWhitelistConfig = {
  whitelist: [],
  blacklist: [],
  max_kept_lines: DEFAULT_MAX_KEPT_LINES,
  truncate_marker: "... [N more lines]",
  log_filtered_count: true,
  suppress_patterns: [],
};

export function compilePatterns(patterns: string[]): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    if (pattern.length === 0) continue;
    // Reject ReDoS-prone patterns before compiling — user YAML may supply
    // catastrophically-backtracking expressions like `^(a+)+$` that would
    // hang every tool.execute.after / experimental.text.complete hook.
    if (!safeRegex(pattern)) {
      log.warn("unsafe regex pattern (rejected to prevent ReDoS):", pattern);
      continue;
    }
    try {
      compiled.push(new RegExp(pattern));
    } catch (e) {
      // Surface the bad pattern — silently swallowing it (via new RegExp(""))
      // made the filter match everything and then drop it, hiding typos.
      log.warn("invalid regex pattern:", pattern, e);
    }
  }
  return compiled;
}

interface PluginState {
  config: LogWhitelistConfig;
  whitelist: RegExp[];
  blacklist: RegExp[];
  suppressPatterns: RegExp[];
  totalFiltered: number;
}

export const id = "@sffmc/safety"
/**
 * Apply whitelist/blacklist filtering to multi-line content.
 * Returns filtered output and dropped count if lines were removed, or null if no changes.
 */
function applyFilter(
  state: PluginState,
  content: string,
): { filtered: string; dropped: number } | null {
  const lines = content.split("\n");
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
    if (state.config.log_filtered_count) {
      log.warn(`filtered ${dropped} lines (total: ${state.totalFiltered})`);
    }
    return { filtered: kept.join("\n"), dropped };
  }
  return null;
}

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
    "tool.execute.after": async (
      _toolCtx: { tool: string; sessionID: string; callID: string },
      result: { title?: string; output?: unknown; metadata?: unknown },
    ) => {
      if (state.whitelist.length === 0) return;

      // Only filter string output
      if (typeof result.output !== "string") return;

      const outcome = applyFilter(state, result.output);
      if (outcome) {
        result.output = outcome.filtered;
      }
    },

    "experimental.text.complete": async (
      _msgCtx: { sessionID: string; messageID: string; partID: string },
      data: { text: string },
    ) => {
      if (state.whitelist.length === 0) return data;

      const outcome = applyFilter(state, data.text);
      if (outcome) {
        data.text = outcome.filtered;
      }
      return data;
    },
  };
};

export default { id, server }
