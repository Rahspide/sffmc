import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "./coordinator";
import { loadConfig, type PluginContext } from "@sffmc/shared";

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  dry_run: false,
  watchdog_threshold: 3,
  max_mode_config: {
    n: 3,
    judge_model: "claude-sonnet-4-20250514",
  },
  cost_cap_per_session: 1,
};

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

export const id = "@sffmc/auto-max"
export const server = async (_ctx: PluginContext) => {
  const config = await loadConfig<AutoMaxConfig>("auto-max", defaultConfig);
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

      const isObjectError =
        output !== null &&
        typeof output === "object" &&
        ((output as Record<string, unknown>).error !== undefined ||
          (output as Record<string, unknown>).code !== undefined);

      const session = getOrCreateSession(state, sessionID);

      if (!isError && !hasErrorFlag && !isObjectError) {
        recordSuccess(session, tool);
        return;
      }

      let errorType: string;
      if (isObjectError && !isError && !hasErrorFlag) {
        const o = output as Record<string, unknown>;
        errorType = "object:" + String(o.code || o.error);
      } else {
        errorType = extractErrorType(output);
      }
      recordFailure(session, tool, errorType);

      if (shouldTriggerMaxMode(session, tool, errorType, config)) {
        if (config.dry_run) {
          const failCount = session.failCount.get(`${tool}::${errorType}`) ?? 0;
          console.warn(
            `[auto-max] dry_run=true: would trigger max-mode for session=${sessionID} (failures=${failCount}, threshold=${config.watchdog_threshold})`,
          );
          return;
        }

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

    "command.execute.before": async (cmdCtx: {
      command: string;
      sessionID: string;
    }) => {
      if (!config.enabled) return;
      const cmd = (cmdCtx.command ?? "").trim();
      const maxMatch = cmd.match(
        /^\/max(?:\s+(reset|clear)(?:\s+(\S+))?)?$/,
      );
      if (!maxMatch) return;

      const targetSessionID = maxMatch[2] || cmdCtx.sessionID;
      const session = getOrCreateSession(state, targetSessionID);
      resetSession(session);
      session.maxCallsThisSession = 0;
      console.warn(
        `[auto-max] /max escape: counters reset for session ${targetSessionID}`,
      );
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
      return data;
    },
  };
};

export default { id, server }
