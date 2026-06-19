export interface AutoMaxConfig {
  enabled: boolean;
  dryRun: boolean;
  watchdogThreshold: number;
  maxModeConfig: {
    n: number;
    judgeModel: string;
  };
  costCapPerSession: number;
}

export interface SessionState {
  failCount: Map<string, number>;
  maxCallsThisSession: number;
  triggered: boolean;
}

export function createSessionState(): SessionState {
  return {
    failCount: new Map(),
    maxCallsThisSession: 0,
    triggered: false,
  };
}

function toolKey(tool: string, errorType: string): string {
  return `${tool}::${errorType}`;
}

export function recordFailure(
  state: SessionState,
  tool: string,
  errorType: string,
): void {
  const k = toolKey(tool, errorType);
  const current = state.failCount.get(k) ?? 0;
  state.failCount.set(k, current + 1);
}

export function recordSuccess(state: SessionState, tool: string): void {
  for (const k of state.failCount.keys()) {
    if (k.startsWith(`${tool}::`)) {
      state.failCount.delete(k);
    }
  }
}

export function shouldTriggerMaxMode(
  state: SessionState,
  tool: string,
  errorType: string,
  config: AutoMaxConfig,
): boolean {
  if (!config.enabled) return false;
  if (state.triggered) return false;
  if (state.maxCallsThisSession >= config.costCapPerSession) return false;

  const k = toolKey(tool, errorType);
  return (state.failCount.get(k) ?? 0) >= config.watchdogThreshold;
}

export function markTriggered(state: SessionState): void {
  state.triggered = true;
  state.maxCallsThisSession++;
}

export function resetSession(state: SessionState): void {
  state.failCount.clear();
  state.triggered = false;
}
