// SPDX-License-Identifier: MIT
// @sffmc/auto-max — see ../../LICENSE
//
// Auto-Max: Watches tool failures and triggers Max Mode after a
// configurable threshold of consecutive same-tool errors. Mirrors the
// safety/watchdog pattern but auto-resolves to Max Mode generation
// instead of single-tool retry, and re-arms /max escape.

import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "./coordinator";
import {
  extractErrorType,
  MAX_PATTERN,
  loadConfig,
  type PluginContext,
  createLogger,
  hasMetadataError,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_CANDIDATE_COUNT,
  HOOK_CHAT_SYSTEM_TRANSFORM,
  HOOK_COMMAND_EXECUTE_BEFORE,
  HOOK_TOOL_EXECUTE_AFTER,
  SESSION_CREATED,
} from "@sffmc/shared";

const log = createLogger("auto-max");

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  dryRun: false,
  watchdogThreshold: DEFAULT_FAILURE_THRESHOLD,
  maxModeConfig: {
    n: DEFAULT_CANDIDATE_COUNT,
    judgeModel: "",
  },
  costCapPerSession: 1,
};

interface AutoMaxTrigger {
  tool: string;
  errorType: string;
  failCount: number;
  sessionID: string;
  maxConfig: AutoMaxConfig["maxModeConfig"];
}

interface PluginState {
  config: AutoMaxConfig;
  sessions: Map<string, ReturnType<typeof createSessionState>>;
  /** Pending one-shot escalation fragment per session. Consumed (and deleted) by
   *  experimental.chat.system.transform when it fires for that session.
   *  Per-instance — was previously stashed on ctx (`pendingTriggers`), which
   *  leaked across sessions in long-running processes. */
  pendingTriggers: Map<string, AutoMaxTrigger>;
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
    pendingTriggers: new Map(),
  };

  if (!loadedLogged) {
    loadedLogged = true;
    if (config.enabled) {
      log.warn(
        `loaded, threshold=${config.watchdogThreshold}, cap=${config.costCapPerSession}/session`,
      );
    } else {
      log.warn("loaded, DISABLED via config");
    }
  }

  return {
    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === SESSION_CREATED) {
        const sessionID = String(payload.sessionID || "");
        // Bug 3b: resetSession clears inner counters but leaves the outer
        // Map entry behind, so state.sessions grows unbounded over a
        // long-running daemon (each unique sessionID accumulates a
        // SessionState holding its own failCount Map forever). Delete +
        // recreate via getOrCreateSession gives a true clean slate per
        // session — fresh failCount, fresh triggered, AND fresh
        // maxCallsThisSession (matches HOOK_COMMAND_EXECUTE_BEFORE
        // /max-reset behavior, so the cost cap re-arms too).
        state.sessions.delete(sessionID);
        getOrCreateSession(state, sessionID);
      }
    },

    // @internal — test-only inspector. Not part of the plugin contract.
    // Exists so tests can verify Bug 3b (state.sessions leak) without
    // reaching into module-private state.
    _getSessionCount: () => state.sessions.size,

    [HOOK_TOOL_EXECUTE_AFTER]: async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      result: { title?: string; output?: unknown; metadata?: unknown },
    ) => {
      if (!config.enabled) return;

      const { tool, sessionID } = toolCtx;
      const output = result.output ?? result.metadata ?? "";
      const meta = result.metadata as { error?: unknown } | null | undefined;

      // Compute the error type once. extractErrorType walks o.code / o.name /
      // string-prefix; cached below to avoid a second walk on the error path.
      const errorType = extractErrorType(output);

      // Error path: extractErrorType covers o.code / o.name; hasMetadataError
      // covers the explicit meta.error flag. isObjectError branch (extracted
      // in determineErrorType before this commit) is now subsumed by
      // extractErrorType's "if (o.code) / if (o.name)" checks.
      if (!hasMetadataError(meta) && errorType === "UNKNOWN") {
        recordSuccess(getOrCreateSession(state, sessionID), tool);
        return;
      }
      handleTrigger(state, config, tool, errorType, sessionID);
      return;
    },

    [HOOK_COMMAND_EXECUTE_BEFORE]: async (cmdCtx: {
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

    [HOOK_CHAT_SYSTEM_TRANSFORM]: async (
      _input: { sessionID?: string },
      data: { system: string[] },
    ) => {
      const sessionID = _input.sessionID;
      if (!sessionID) return data;
      const trigger = state.pendingTriggers.get(sessionID);

      if (trigger) {
        data.system.push(
          [
            `⚡ AUTO-MAX TRIGGERED: \`${trigger.tool}:${trigger.errorType}\` failed ${trigger.failCount} consecutive times.`,
            `Max Mode will generate parallel candidate solutions to break the loop.`,
          ].join("\n"),
        );
        state.pendingTriggers.delete(sessionID);
      }
      return data;
    },
  };
};

function handleTrigger(
  state: PluginState,
  config: AutoMaxConfig,
  tool: string,
  errorType: string,
  sessionID: string,
): void {
  const session = getOrCreateSession(state, sessionID);
  recordFailure(session, tool, errorType);
  // Used by both the dryRun and cap-blocked log paths below.
  const toolErrorKey = `${tool}::${errorType}`;
  const failCount = session.failCount.get(toolErrorKey) ?? 0;

  if (shouldTriggerMaxMode(session, tool, errorType, config)) {
    if (config.dryRun) {
      log.warn(
        `dryRun=true: would trigger max-mode for session=${sessionID} (failures=${failCount}, threshold=${config.watchdogThreshold})`,
      );
      return;
    }

    markTriggered(session);

    log.warn(
      `TRIGGERED: ${tool}:${errorType} failed ${config.watchdogThreshold}x in session ${sessionID}\n` +
      `→ Activating Max Mode, generating ${config.maxModeConfig.n} candidates`,
    );

    state.pendingTriggers.set(sessionID, {
      tool,
      errorType,
      failCount: config.watchdogThreshold,
      sessionID,
      maxConfig: config.maxModeConfig,
    });
    return;
  }

  // Cap-blocked path — shouldTriggerMaxMode returned false because
  // session.maxCallsThisSession has already hit costCapPerSession. The
  // trigger is silently suppressed in the pure-function path; emit an
  // explicit observability log so operators can confirm the cap is
  // enforced rather than assuming the trigger fired (production saw 7
  // suspected triggers during v0.14.0 — turned out the cap was firing
  // correctly but the suppression was invisible).
  if (session.maxCallsThisSession >= config.costCapPerSession) {
    log.warn(
      `cap reached (${session.maxCallsThisSession}/${config.costCapPerSession}): skipping trigger for ${tool}:${errorType} (failures=${failCount}) in session ${sessionID}`,
    );
  }
}

export default { id, server }
