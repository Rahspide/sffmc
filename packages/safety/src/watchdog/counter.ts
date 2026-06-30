export interface Failure {
  tool: string;
  errorType: string;
  sessionID: string;
  timestamp: number;
}

interface CounterKey {
  tool: string;
  errorType: string;
  sessionID: string;
}

function key(tool: string, errorType: string, sessionID: string): string {
  return `${sessionID}::${tool}::${errorType}`;
}

export class FailureCounter {
  private counts: Map<string, number> = new Map();
  private recent: Failure[] = [];
  private threshold: number;
  private windowSize: number;

  constructor(threshold: number, windowSize: number) {
    this.threshold = threshold;
    this.windowSize = windowSize;
  }

  recordFailure(tool: string, errorType: string, sessionID: string): void {
    const k = key(tool, errorType, sessionID);
    const current = this.counts.get(k) ?? 0;
    this.counts.set(k, current + 1);

    this.recent.push({
      tool,
      errorType,
      sessionID,
      timestamp: Date.now(),
    });

    // Trim to rolling window
    if (this.recent.length > this.windowSize) {
      this.recent = this.recent.slice(-this.windowSize);
    }
  }

  shouldPromote(tool: string, errorType: string, sessionID: string): boolean {
    const k = key(tool, errorType, sessionID);
    return (this.counts.get(k) ?? 0) >= this.threshold;
  }

  recordSuccess(tool: string, sessionID: string): void {
    // Reset all counters for this tool in this session
    for (const k of this.counts.keys()) {
      if (k.startsWith(`${sessionID}::${tool}::`)) {
        this.counts.delete(k);
      }
    }
  }

  getRecentFailures(sessionID: string, limit: number): Failure[] {
    return this.recent
      .filter((f) => f.sessionID === sessionID)
      .slice(-limit);
  }

  /** Full reset for a session (e.g., on session.created) */
  resetSession(sessionID: string): void {
    for (const k of this.counts.keys()) {
      if (k.startsWith(`${sessionID}::`)) {
        this.counts.delete(k);
      }
    }
    this.recent = this.recent.filter((f) => f.sessionID !== sessionID);
  }
}
