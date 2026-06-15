import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "./coordinator";
import { parse as parseYaml } from "yaml";
import { type PluginContext } from "@sffmc/shared";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  watchdog_threshold: 3,
  max_mode_config: {
    n: 3,
    judge_model: "ocg/deepseek-v4-flash",
  },
  cost_cap_per_session: 1,
};

function loadConfig(): AutoMaxConfig {
  const configPath = resolve(homedir(), ".config/SFFMC/auto-max.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<AutoMaxConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

interface PluginState {
  config: AutoMaxConfig;
  sessions: Map<string, ReturnType<typeof createSessionState>>;
  triggeredLog: Array<{
    sessionID: string;
    tool: string;
    errorType: string;
    timestamp: number;
  }>;
}

function extractErrorType(output: unknown): string {
  if (typeof output === "string") {
    const errMatch = output.match(
      /(ENOENT|EACCES|EPERM|EAGAIN|ECONNREFUSED|ETIMEDOUT|ERR_|Error:|error:)/i,
    );
    if (errMatch) return errMatch[1].toUpperCase();
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.code === "string") return o.code;
    if (typeof o.name === "string") return o.name;
  }
  return "UNKNOWN";
}

function getOrCreateSession(state: PluginState, sessionID: string) {
  let session = state.sessions.get(sessionID);
  if (!session) {
    session = createSessionState();
    state.sessions.set(sessionID, session);
  }
  return session;
}

let loadedLogged = false;

const server = async (_ctx: PluginContext) => {
  const config = loadConfig();
  const state: PluginState = {
    config,
    sessions: new Map(),
    triggeredLog: [],
  };

  if (config.enabled && !loadedLogged) {
    loadedLogged = true;
    console.warn(
      `[auto-max] loaded, threshold=${config.watchdog_threshold}, cap=${config.cost_cap_per_session}/session`,
    );
  } else if (!loadedLogged) {
    loadedLogged = true;
    console.warn("[auto-max] loaded, DISABLED via config");
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config loaded on startup
    },

    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === "session.created") {
        const sid = String(payload.sessionID || "");
        resetSession(getOrCreateSession(state, sid));
      }
    },

    "tool.execute.after": async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      result: { title?: string; output?: unknown; metadata?: unknown },
    ) => {
      if (!config.enabled) return;

      const { tool, sessionID } = toolCtx;
      const output = result.output ?? result.metadata ?? "";

      const isError =
        typeof output === "string" &&
        /error|fail|ERR_|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED/i.test(output);

      const meta = result.metadata as Record<string, unknown> | undefined;
      const hasErrorFlag =
        meta?.error !== undefined && meta?.error !== null && meta?.error !== false;

      const session = getOrCreateSession(state, sessionID);

      if (!isError && !hasErrorFlag) {
        recordSuccess(session, tool);
        return;
      }

      const errorType = extractErrorType(output);
      recordFailure(session, tool, errorType);

      if (shouldTriggerMaxMode(session, tool, errorType, config)) {
        markTriggered(session);

        state.triggeredLog.push({
          sessionID,
          tool,
          errorType,
          timestamp: Date.now(),
        });

        console.warn(
          `[auto-max] TRIGGERED: ${tool}:${errorType} failed ${config.watchdog_threshold}x in session ${sessionID}`,
        );
        console.warn(
          `[auto-max] Activating Max Mode — generating ${config.max_mode_config.n} candidates`,
        );

        // Store trigger info in ctx for max-mode to pick up
        (_ctx as Record<string, unknown>)._autoMaxTrigger = {
          tool,
          errorType,
          failCount: config.watchdog_threshold,
          sessionID,
          maxConfig: config.max_mode_config,
        };
      }
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      data: { system: string[] },
    ) => {
      const trigger = (_ctx as Record<string, unknown>)._autoMaxTrigger as
        | { tool: string; errorType: string; failCount: number; sessionID: string }
        | undefined;

      if (trigger) {
        data.system.push(
          [
            `⚡ AUTO-MAX TRIGGERED: \`${trigger.tool}:${trigger.errorType}\` failed ${trigger.failCount} consecutive times.`,
            `Max Mode will generate parallel candidate solutions to break the loop.`,
          ].join("\n"),
        );
        delete (_ctx as Record<string, unknown>)._autoMaxTrigger;
      }
    },
  };
};

export default {
  id: "@sffmc/auto-max",
  server,
};
