import { FailureCounter } from "./counter";
import { buildPromotionFragment } from "./promote";
import { buildRecoveryVerdict } from "./verdict";
import { extractErrorType, isToolError, hasMetadataError, MAX_PATTERN, loadConfig, type PluginContext, createLogger, SESSION_CREATED } from "@sffmc/shared";

const log = createLogger("watchdog");

interface WatchdogConfig {
  threshold: number;
  rolling_window: number;
  promote_model: string | null;
  error_class_filter: string[];
  log_failures: boolean;
  // second release migration (watchdog log file) — see
  // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.7
  /** watchdog log file — how many recent failures to include in the promotion fragment
   *  injected into the system prompt when a tool gets stuck. Defaults to
   *  5 (matches the prior hardcoded value). Validation: 1 ≤ x ≤ 50. */
  recentFailuresLimit: number;
}

export const defaultConfig: WatchdogConfig = {
  threshold: 3,
  rolling_window: 10,
  promote_model: null,
  error_class_filter: ["fetch_429", "playwright_timeout", "EAGAIN"],
  log_failures: true,
  // Defaults match the prior hardcoded values — behavior unchanged.
  recentFailuresLimit: 5,   // watchdog log file
};

interface PluginState {
  counter: FailureCounter;
  config: WatchdogConfig;
  promotedSessions: Set<string>;
  recoveringTools: Map<string, { errorType: string; attempts: number }>;
}



function isFiltered(errorType: string, filter: string[]): boolean {
  return filter.some((f) => errorType.toLowerCase().includes(f.toLowerCase()));
}

function recoveryKey(sessionID: string, tool: string): string {
  return `${sessionID}::${tool}`;
}

let loadedLogged = false;

export const id = "@sffmc/watchdog"
export const server = async (ctx: PluginContext) => {
  const config = await loadConfig<WatchdogConfig>("watchdog", defaultConfig);
  const state: PluginState = {
    counter: new FailureCounter(config.threshold, config.rolling_window),
    config,
    promotedSessions: new Set(),
    recoveringTools: new Map(),
  };

  // Resolve the promote-model with a 3-tier fallback chain:
  //   1. config.promote_model (explicit watchdog.yaml override)
  //   2. ctx.config?.model    (OpenCode plugin-config override)
  //   3. "(default)"          (neither set — emit a visible marker instead of
  //                            an empty value so operators can confirm whether
  //                            a fallback is actually configured)
  //
  // Bug fix v0.14.1: production logs showed `model=` (empty) when both
  // promote_model was null (default) AND ctx.config.model was undefined.
  // The empty value made it impossible to tell whether the configured
  // fallback had loaded correctly or the chain had silently degraded.
  const model =
    config.promote_model ||
    String(ctx.config?.model || "") ||
    "(default)";

  if (config.log_failures && !loadedLogged) {
    loadedLogged = true;
    log.warn(
      `loaded, threshold=${config.threshold}, model=${model}`,
    );
  }

  return {
    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === SESSION_CREATED) {
        const sid = String(payload.sessionID || "");
        state.counter.resetSession(sid);
        state.promotedSessions.delete(sid);
        state.recoveringTools.clear();
      }
    },

    "tool.execute.after": async (
      toolCtx: { tool: string; sessionID: string; callID: string },
      result: { title?: string; output?: unknown; metadata?: unknown },
    ) => {
      const { tool, sessionID } = toolCtx;
      const output = result.output ?? result.metadata ?? "";

      const meta = result.metadata as Record<string, unknown> | undefined;
      const isError = isToolError(output);
      const hasErrorFlag = hasMetadataError(meta);

      if (!isError && !hasErrorFlag) {
        handleSuccess(sessionID, tool, result, state.counter, state.recoveringTools);
        return;
      }

      const errorType = extractErrorType(output);

      if (isFiltered(errorType, config.error_class_filter)) {
        return;
      }

      handlePromotion(
        sessionID,
        tool,
        errorType,
        state.counter,
        state.promotedSessions,
        state.recoveringTools,
        config.threshold,
        config.log_failures,
      );
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model?: unknown },
      data: { system: string[] },
    ) => {
      const sid = _input.sessionID || "";
      if (!state.promotedSessions.has(sid)) return data;

      const recent = state.counter.getRecentFailures(sid, config.recentFailuresLimit);
      if (recent.length === 0) return data;

      const last = recent[recent.length - 1];
      const fragment = buildPromotionFragment(
        last.tool,
        last.errorType,
        config.threshold,
        model,
      );
      data.system.push(fragment);

      state.promotedSessions.delete(sid);
      return data;
    },

    "command.execute.before": async (
      cmdCtx: { command: string; sessionID: string },
    ) => {
      if (MAX_PATTERN.test(cmdCtx.command)) {
        const sid = cmdCtx.sessionID;
        state.counter.resetSession(sid);
        state.promotedSessions.delete(sid);
        state.recoveringTools.clear();
        if (config.log_failures) {
          log.warn(`/max escape hatch: all counters reset for session ${sid}`);
        }
      }
    },
  };
};

function handleSuccess(
  sessionID: string,
  tool: string,
  result: { output?: unknown },
  counter: FailureCounter,
  recoveringTools: Map<string, { errorType: string; attempts: number }>,
): void {
  const recovery = recoveringTools.get(recoveryKey(sessionID, tool));
  if (recovery) {
    const verdict = buildRecoveryVerdict(tool, recovery.errorType, recovery.attempts);
    if (typeof result.output === "string") {
      result.output = `${verdict}\n${result.output}`;
    }
    recoveringTools.delete(recoveryKey(sessionID, tool));
  }
  counter.recordSuccess(tool, sessionID);
}

function handlePromotion(
  sessionID: string,
  tool: string,
  errorType: string,
  counter: FailureCounter,
  promotedSessions: Set<string>,
  recoveringTools: Map<string, { errorType: string; attempts: number }>,
  threshold: number,
  logFailures: boolean,
): void {
  counter.recordFailure(tool, errorType, sessionID);
  if (logFailures) {
    log.warn(`failure: ${tool}:${errorType} (session ${sessionID})`);
  }
  if (counter.shouldPromote(tool, errorType, sessionID)) {
    promotedSessions.add(sessionID);
    recoveringTools.set(recoveryKey(sessionID, tool), { errorType, attempts: threshold });
  }
}

export default { id, server }
