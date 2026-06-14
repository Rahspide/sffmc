import { FailureCounter } from "./counter";
import { buildPromotionFragment } from "./promote";
import { buildRecoveryVerdict } from "./verdict";
import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { homedir } from "os";

interface WatchdogConfig {
  threshold: number;
  rolling_window: number;
  promote_model: string | null;
  error_class_filter: string[];
  log_failures: boolean;
}

const defaultConfig: WatchdogConfig = {
  threshold: 3,
  rolling_window: 10,
  promote_model: null,
  error_class_filter: ["fetch_429", "playwright_timeout", "EAGAIN"],
  log_failures: true,
};

function loadConfig(): WatchdogConfig {
  const configPath = resolve(homedir(), ".config/SFFMC/watchdog.yaml");
  if (!existsSync(configPath)) return { ...defaultConfig };
  try {
    const raw = readFileSync(configPath, "utf-8");
    const parsed = parseYaml(raw) as Partial<WatchdogConfig>;
    return { ...defaultConfig, ...parsed };
  } catch {
    return { ...defaultConfig };
  }
}

interface PluginState {
  counter: FailureCounter;
  config: WatchdogConfig;
  promotedSessions: Set<string>;
  recoveringTools: Map<string, { errorType: string; attempts: number }>;
}

interface PluginContext {
  projectRoot: string;
  config: Record<string, unknown>;
  [key: string]: unknown;
}

function extractErrorType(args: Record<string, unknown>, output: unknown): string {
  if (typeof output === "string") {
    const errMatch = output.match(/(ENOENT|EACCES|EPERM|EAGAIN|ECONNREFUSED|ETIMEDOUT|ERR_|Error:|error:)/i);
    if (errMatch) return errMatch[1].toUpperCase();
  }
  // Check for structured error
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>;
    if (typeof o.code === "string") return o.code;
    if (typeof o.name === "string") return o.name;
  }
  return "UNKNOWN";
}

function isFiltered(errorType: string, filter: string[]): boolean {
  return filter.some((f) => errorType.toLowerCase().includes(f.toLowerCase()));
}

const server = async (ctx: PluginContext) => {
  const config = loadConfig();
  const state: PluginState = {
    counter: new FailureCounter(config.threshold, config.rolling_window),
    config,
    promotedSessions: new Set(),
    recoveringTools: new Map(),
  };

  const model = config.promote_model || String(ctx.config?.model || "ocg/deepseek-v4-flash");

  if (config.log_failures) {
    console.warn(
      `[watchdog] loaded, threshold=${config.threshold}, model=${model}`,
    );
  }

  return {
    config: async (_cfg: Record<string, unknown>) => {
      // Config already loaded on startup; no-op
    },

    event: async (payload: { event: string; [key: string]: unknown }) => {
      if (payload.event === "session.created") {
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

      // Detect failures via output content or metadata error flag
      const meta = result.metadata as Record<string, unknown> | undefined;
      const isError =
        typeof output === "string" &&
        /error|fail|ERR_|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED/i.test(output);

      const hasErrorFlag =
        meta?.error !== undefined && meta?.error !== null && meta?.error !== false;

      if (!isError && !hasErrorFlag) {
        // Success — reset counter, inject recovery verdict
        const recoveryKey = `${sessionID}::${tool}`;
        const recovery = state.recoveringTools.get(recoveryKey);
        if (recovery) {
          const verdict = buildRecoveryVerdict(tool, recovery.errorType, recovery.attempts);
          // Inject into output
          if (typeof result.output === "string") {
            result.output = `${verdict}\n${result.output}`;
          }
          state.recoveringTools.delete(recoveryKey);
        }
        state.counter.recordSuccess(tool, sessionID);
        return;
      }

      const errorType = extractErrorType(
        {},
        output,
      );

      if (isFiltered(errorType, config.error_class_filter)) {
        return;
      }

      state.counter.recordFailure(tool, errorType, sessionID);

      if (config.log_failures) {
        console.warn(`[watchdog] failure: ${tool}:${errorType} (session ${sessionID})`);
      }

      if (state.counter.shouldPromote(tool, errorType, sessionID)) {
        state.promotedSessions.add(sessionID);
        state.recoveringTools.set(`${sessionID}::${tool}`, {
          errorType,
          attempts: config.threshold,
        });
      }
    },

    "experimental.chat.system.transform": async (
      _input: { sessionID?: string; model?: unknown },
      data: { system: string[] },
    ) => {
      const sid = _input.sessionID || "";
      if (!state.promotedSessions.has(sid)) return;

      const recent = state.counter.getRecentFailures(sid, 5);
      if (recent.length === 0) return;

      const last = recent[recent.length - 1];
      const fragment = buildPromotionFragment(
        last.tool,
        last.errorType,
        config.threshold,
        model,
      );
      data.system.push(fragment);

      state.promotedSessions.delete(sid);
    },

    "experimental.chat.messages.transform": async (
      _input: unknown,
      data: {
        messages: Array<{ role: string; content: string; [key: string]: unknown }>;
      },
    ) => {
      // Recovery verdict injected in tool.execute.after, not here
    },

    "command.execute.before": async (
      cmdCtx: { command: string; sessionID: string },
    ) => {
      if (cmdCtx.command === "/max") {
        const sid = cmdCtx.sessionID;
        state.counter.resetSession(sid);
        state.promotedSessions.delete(sid);
        state.recoveringTools.clear();
        if (config.log_failures) {
          console.warn(`[watchdog] /max escape hatch: all counters reset for session ${sid}`);
        }
      }
    },
  };
};

export default {
  id: "@sffmc/watchdog",
  server,
};
