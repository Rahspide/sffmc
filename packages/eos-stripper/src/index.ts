import { stripEos, looksLikeEosOnly, DEFAULT_EOS_PATTERNS } from "./patterns";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface EosConfig {
  patterns: string[];
  strip_from_end_only: boolean;
  log_stripped_count: boolean;
}

const defaultConfig: EosConfig = {
  patterns: [],
  strip_from_end_only: true,
  log_stripped_count: true,
};

function loadConfig(): EosConfig {
  const configPath = resolve(homedir(), ".config/SFFMC/eos.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<EosConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

interface PluginState {
  config: EosConfig;
  patterns: string[];
  strippedCount: number;
}

interface PluginContext {
  projectRoot: string;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

const server = async (_ctx: PluginContext) => {
  const config = loadConfig();
  const patterns = config.patterns.length > 0 ? config.patterns : DEFAULT_EOS_PATTERNS;

  const state: PluginState = {
    config,
    patterns,
    strippedCount: 0,
  };

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config loaded on startup
    },

    "experimental.text.complete": async (
      _msgCtx: { sessionID: string; messageID: string; partID: string },
      data: { text: string },
    ) => {
      if (looksLikeEosOnly(data.text, state.patterns)) {
        data.text = "";
        state.strippedCount++;
        if (state.config.log_stripped_count) {
          console.warn(`[eos-stripper] stripped entire EOS-only text part`);
        }
        return;
      }

      const original = data.text;
      data.text = stripEos(data.text, state.patterns);

      if (data.text !== original) {
        state.strippedCount++;
        if (state.config.log_stripped_count) {
          console.warn(`[eos-stripper] stripped EOS from text end (${state.strippedCount} total)`);
        }
      }
    },
  };
};

export default {
  id: "@sffmc/eos-stripper",
  server,
};
