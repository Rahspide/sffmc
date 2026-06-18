import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "./coordinator";
import { extractErrorType, isToolError, MAX_PATTERN, loadConfig, type PluginContext, createLogger, hasMetadataError } from "@sffmc/shared";

const log = createLogger("auto-max");

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  dry_run: false,
  watchdog_threshold: 3,
  max_mode_config: {
    n: 3,
    judge_model: "",
  },
  cost_cap_per_session: 1,
};

interface AutoMaxTrigger {
  tool: string;
  errorType: string;
  failCount: number;
  sessionID: string;
  maxConfig: AutoMaxConfig["max_mode_config"];
}

interface PluginState {
  config: AutoMaxConfig;
  sessions: Map<string, ReturnType<typeof createSessionState>>;
  /** Pending one-shot escalation fragment per session. Consumed (and deleted) by
   *  experimental.chat.system.transform when it fires for that session.
   *  Per-instance — was previously stashed on ctx (`_autoMaxTrigger`), which
   *  leaked across sessions in long-running processes. */
  _autoMaxTrigger: Map<string, AutoMaxTrigger>;
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
    _autoMaxTrigger: new Map(),
  };

  if (!loadedLogged) {
    loadedLogged = true;
    if (config.enabled) {
      log.warn(
        `loaded, threshold=${config.watchdog_threshold}, cap=${config.cost_cap_per_session}/session`,
      );
    } else {
      log.warn("loaded, DISABLED via config");
    }
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
      const meta = result.metadata as { error?: unknown } | null | undefined;

      const errorType = determineErrorType(tool, meta, output);
      if (!errorType) {
        handleSuccess(state, sessionID, tool);
        return;
      }
      handleTrigger(state, config, tool, errorType, sessionID);
      return;
    },

    "command.execute.before": async (cmdCtx: {
      command: string;
      sessionID: string;
    }) => {
      if (!config.enabled) return;
      const cmd = (cmdCtx.command ?? "").trim();
      const maxMatch = MAX_PATTERN.exec(cmd);
      if (!maxMatch) return;

      const targetSessionID = maxMatch[2] || cmdCtx.sessionID;
      const session = getOrCreateSession(state, targetSessionID);
      resetSession(session);
      session.maxCallsThisSession = 0;
      log.warn(
        `/max escape: counters reset for session ${targetSessionID}`,
      );
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string },
      data: { system: string[] },
    ) => {
      const sessionID = _input.sessionID;
      if (!sessionID) return data;
      const trigger = state._autoMaxTrigger.get(sessionID);

      if (trigger) {
        data.system.push(
          [
            `⚡ AUTO-MAX TRIGGERED: \`${trigger.tool}:${trigger.errorType}\` failed ${trigger.failCount} consecutive times.`,
            `Max Mode will generate parallel candidate solutions to break the loop.`,
          ].join("\n"),
        );
        state._autoMaxTrigger.delete(sessionID);
      }
      return data;
    },
  };
};

function determineErrorType(
  tool: string,
  meta: { error?: unknown } | null | undefined,
  output: unknown,
): string {
  const isError = isToolError(output);
  const hasErrorFlag = hasMetadataError(meta);

  const isObjectError =
    output !== null &&
    typeof output === "object" &&
    ((output as Record<string, unknown>).error !== undefined ||
      (output as Record<string, unknown>).code !== undefined);

  if (!isError && !hasErrorFlag && !isObjectError) {
    return "";
  }

  if (isObjectError && !isError && !hasErrorFlag) {
    const o = output as Record<string, unknown>;
    return "object:" + String(o.code || o.error);
  }
  return extractErrorType(output);
}

function handleSuccess(
  state: PluginState,
  sessionID: string,
  tool: string,
): void {
  const session = getOrCreateSession(state, sessionID);
  recordSuccess(session, tool);
}

function handleTrigger(
  state: PluginState,
  config: AutoMaxConfig,
  tool: string,
  errorType: string,
  sessionID: string,
): void {
  const session = getOrCreateSession(state, sessionID);
  recordFailure(session, tool, errorType);

  if (shouldTriggerMaxMode(session, tool, errorType, config)) {
    if (config.dry_run) {
      const failCount = session.failCount.get(`${tool}::${errorType}`) ?? 0;
      log.warn(
        `dry_run=true: would trigger max-mode for session=${sessionID} (failures=${failCount}, threshold=${config.watchdog_threshold})`,
      );
      return;
    }

    markTriggered(session);

    log.warn(
      `TRIGGERED: ${tool}:${errorType} failed ${config.watchdog_threshold}x in session ${sessionID}\n` +
      `→ Activating Max Mode, generating ${config.max_mode_config.n} candidates`,
    );

    state._autoMaxTrigger.set(sessionID, {
      tool,
      errorType,
      failCount: config.watchdog_threshold,
      sessionID,
      maxConfig: config.max_mode_config,
    });
  }
}

export default { id, server }
