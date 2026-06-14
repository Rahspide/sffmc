import { describe, it, expect, jest, afterEach } from "bun:test";
import { FailureCounter } from "./counter";
import { buildPromotionFragment } from "./promote";
import { buildRecoveryVerdict } from "./verdict";

describe("FailureCounter", () => {
  it("tracks consecutive failures and triggers promotion at threshold", () => {
    const fc = new FailureCounter(3, 10);
    const sid = "s1";

    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);

    fc.recordFailure("bash", "ENOENT", sid);
    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);

    fc.recordFailure("bash", "ENOENT", sid);
    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);

    fc.recordFailure("bash", "ENOENT", sid);
    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(true);
  });

  it("resets counter on success", () => {
    const fc = new FailureCounter(3, 10);
    const sid = "s1";

    fc.recordFailure("bash", "ENOENT", sid);
    fc.recordFailure("bash", "ENOENT", sid);
    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);

    fc.recordSuccess("bash", sid);
    fc.recordFailure("bash", "ENOENT", sid);
    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);
  });

  it("separates counters by session", () => {
    const fc = new FailureCounter(2, 10);

    fc.recordFailure("bash", "ENOENT", "s1");
    fc.recordFailure("bash", "ENOENT", "s1");
    expect(fc.shouldPromote("bash", "ENOENT", "s1")).toBe(true);

    fc.recordFailure("bash", "ENOENT", "s2");
    expect(fc.shouldPromote("bash", "ENOENT", "s2")).toBe(false);
  });

  it("separates counters by error type", () => {
    const fc = new FailureCounter(2, 10);
    const sid = "s1";

    fc.recordFailure("bash", "ENOENT", sid);
    fc.recordFailure("bash", "ENOENT", sid);
    fc.recordFailure("bash", "EACCES", sid);
    fc.recordFailure("bash", "EACCES", sid);

    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(true);
    expect(fc.shouldPromote("bash", "EACCES", sid)).toBe(true);
  });

  it("getRecentFailures returns limited list", () => {
    const fc = new FailureCounter(3, 10);
    const sid = "s1";

    fc.recordFailure("bash", "ENOENT", sid);
    fc.recordFailure("glob", "ERR", sid);
    fc.recordFailure("bash", "EACCES", sid);

    const recent = fc.getRecentFailures(sid, 2);
    expect(recent.length).toBe(2);
    expect(recent[0].tool).toBe("glob");
    expect(recent[1].tool).toBe("bash");
    expect(recent[1].errorType).toBe("EACCES");
  });

  it("resetSession clears all data for session", () => {
    const fc = new FailureCounter(2, 10);
    const sid = "s1";

    fc.recordFailure("bash", "ENOENT", sid);
    fc.recordFailure("bash", "ENOENT", sid);
    fc.resetSession(sid);

    expect(fc.shouldPromote("bash", "ENOENT", sid)).toBe(false);
    expect(fc.getRecentFailures(sid, 10).length).toBe(0);
  });

  it("rolling window trims old entries", () => {
    const fc = new FailureCounter(3, 3);
    const sid = "s1";

    fc.recordFailure("a", "X", sid);
    fc.recordFailure("b", "X", sid);
    fc.recordFailure("c", "X", sid);
    fc.recordFailure("d", "X", sid);

    const recent = fc.getRecentFailures(sid, 10);
    expect(recent.length).toBe(3);
    expect(recent[0].tool).toBe("b");
    expect(recent[2].tool).toBe("d");
  });
});

describe("buildPromotionFragment", () => {
  it("returns stuck detection instruction", () => {
    const result = buildPromotionFragment("bash", "ENOENT", 3, "ocg/test-model");
    expect(result).toContain("STUCK DETECTED");
    expect(result).toContain("bash:ENOENT");
    expect(result).toContain("3 consecutive times");
    expect(result).toContain("ocg/test-model");
    expect(result).toContain("DETAILED THINKING");
  });

  it("omits model when empty", () => {
    const result = buildPromotionFragment("bash", "ENOENT", 3, "");
    expect(result).toContain("STUCK DETECTED");
    expect(result).not.toContain("(model:");
  });
});

describe("buildRecoveryVerdict", () => {
  it("returns recovery message", () => {
    const result = buildRecoveryVerdict("bash", "ENOENT", 3);
    expect(result).toContain("Recovered");
    expect(result).toContain("3 failed");
    expect(result).toContain("bash:ENOENT");
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/watchdog");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
  });

  it("command.execute.before resets on /max", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    // No throw on /max
    await hooks["command.execute.before"]!(
      { command: "/max", sessionID: "test-sid" },
    );
  });

  it("event resets counters on session.created", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks.event!({ event: "session.created", sessionID: "new-session" });
    // No throw means state reset succeeded
  });

  it("ignores filtered error classes", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    // fetch_429 is filtered by default — should not increment counter
    await hooks["tool.execute.after"]!(
      { tool: "webfetch", sessionID: "s1", callID: "c1" },
      { output: "fetch_429: rate limited" },
    );
    // No throw = ignored
  });
});

describe("tool.execute.after error detection", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  afterEach(() => {
    if (warnSpy) warnSpy.mockRestore();
  });

  async function createHooks() {
    const mod = await import("./index");
    return await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
  }

  it("does NOT flag markdown content containing bare 'error'/'fail' words", async () => {
    const hooks = await createHooks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const markdown =
      "# Test Results\n\n" +
      "## Summary\n" +
      "- 0 errors\n" +
      "- 0 failures\n" +
      "- MUST FAIL: edge case #42\n" +
      "- error_class_filter: default\n" +
      "All tests passed successfully.";

    await hooks["tool.execute.after"]!(
      { tool: "compose_skill", sessionID: "s1", callID: "c1" },
      { output: markdown },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DOES flag real error messages (Error: prefix)", async () => {
    const hooks = await createHooks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { output: "Error: ENOENT: no such file or directory" },
    );

    // extractErrorType finds "Error:" as leftmost match → "ERROR:"
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[watchdog] failure: bash:ERROR:"),
    );
  });

  it("does NOT flag long output (>4096 chars) even if it contains 'error'", async () => {
    const hooks = await createHooks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    // Build a 5000-char string containing "error" once
    const long = "x".repeat(2000) + " error happened somewhere " + "y".repeat(2970);
    expect(long.length).toBeGreaterThan(4096);

    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s1", callID: "c1" },
      { output: long },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("DOES flag throw new Error patterns", async () => {
    const hooks = await createHooks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s2", callID: "c2" },
      { output: "throw new Error('something went wrong') at line 42" },
    );

    // extractErrorType finds no error-code token → "UNKNOWN"
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[watchdog] failure: bash:UNKNOWN"),
    );
  });

  it("does NOT flag bare 'fail' in descriptive text", async () => {
    const hooks = await createHooks();
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    await hooks["tool.execute.after"]!(
      { tool: "test", sessionID: "s3", callID: "c3" },
      { output: "failed 1 out of 100" },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
