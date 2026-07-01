import { stripEos, looksLikeEosOnly, DEFAULT_EOS_PATTERNS } from "./patterns";
import { loadConfig, type PluginContext, createLogger } from "@sffmc/utilities";

const log = createLogger("eos-stripper");

interface EosConfig {
  patterns: string[];
  log_stripped_count: boolean;
}

const defaultConfig: EosConfig = {
  patterns: [],
  log_stripped_count: true,
};

interface PluginState {
  config: EosConfig;
  patterns: string[];
  strippedCount: number;
}

export const id = "@sffmc/safety"
export const server = async (_ctx: PluginContext) => {
  const config = await loadConfig<EosConfig>("eos-stripper", defaultConfig);
  const patterns = config.patterns.length > 0 ? config.patterns : DEFAULT_EOS_PATTERNS;

  const state: PluginState = {
    config,
    patterns,
    strippedCount: 0,
  };

  return {
    "experimental.text.complete": async (
      _msgCtx: { sessionID: string; messageID: string; partID: string },
      data: { text: string },
    ) => {
      if (looksLikeEosOnly(data.text, state.patterns)) {
        data.text = "";
        state.strippedCount++;
        if (state.config.log_stripped_count) {
          log.warn(`stripped entire EOS-only text part`);
        }
        return data;
      }

      const original = data.text;
      data.text = stripEos(data.text, state.patterns);

      if (data.text !== original) {
        state.strippedCount++;
        if (state.config.log_stripped_count) {
          log.warn(`stripped EOS from text end (${state.strippedCount} total)`);
        }
      }
      return data;
    },
  };
};

export default { id, server }
