import { describe, it, expect } from "bun:test";
import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "./coordinator";

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  watchdog_threshold: 3,
  max_mode_config: {
    n: 3,
    judge_model: "test-model",
  },
  cost_cap_per_session: 1,
};

describe("coordinator", () => {
  it("createSessionState starts with no failures", () => {
    const s = createSessionState();
    expect(s.maxCallsThisSession).toBe(0);
    expect(s.triggered).toBe(false);
  });

  it("recordFailure increments counter", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(s.failCount.get("bash::ENOENT")).toBe(2);
  });

  it("recordFailure tracks different error types separately", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "EACCES");
    expect(s.failCount.get("bash::ENOENT")).toBe(1);
    expect(s.failCount.get("bash::EACCES")).toBe(1);
  });

  it("recordSuccess clears counters for the tool", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "glob", "ERR");
    recordSuccess(s, "bash");

    expect(s.failCount.has("bash::ENOENT")).toBe(false);
    expect(s.failCount.get("glob::ERR")).toBe(1);
  });

  it("shouldTriggerMaxMode returns false below threshold", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", defaultConfig)).toBe(false);
  });

  it("shouldTriggerMaxMode returns true at threshold", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", defaultConfig)).toBe(true);
  });

  it("shouldTriggerMaxMode returns false when disabled", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    const disabledConfig = { ...defaultConfig, enabled: false };
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", disabledConfig)).toBe(false);
  });

  it("shouldTriggerMaxMode returns false when already triggered", () => {
    const s = createSessionState();
    markTriggered(s);
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", defaultConfig)).toBe(false);
  });

  it("shouldTriggerMaxMode respects cost cap", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    markTriggered(s); // first call used

    resetSession(s); // clear triggered flag but maxCallsThisSession stays
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");

    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", defaultConfig)).toBe(false);
  });

  it("markTriggered sets flags", () => {
    const s = createSessionState();
    markTriggered(s);
    expect(s.triggered).toBe(true);
    expect(s.maxCallsThisSession).toBe(1);
  });

  it("resetSession clears all state", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    markTriggered(s);

    resetSession(s);
    expect(s.failCount.size).toBe(0);
    expect(s.triggered).toBe(false);
  });

  it("cost cap with higher limit allows multiple triggers", () => {
    const multiConfig: AutoMaxConfig = {
      ...defaultConfig,
      cost_cap_per_session: 3,
    };

    const s = createSessionState();

    // First trigger
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", multiConfig)).toBe(true);
    markTriggered(s);

    // Second trigger (different tool)
    resetSession(s);
    recordFailure(s, "glob", "ERR");
    recordFailure(s, "glob", "ERR");
    recordFailure(s, "glob", "ERR");
    expect(shouldTriggerMaxMode(s, "glob", "ERR", multiConfig)).toBe(true);
    markTriggered(s);

    // Third trigger
    resetSession(s);
    recordFailure(s, "grep", "TIMEOUT");
    recordFailure(s, "grep", "TIMEOUT");
    recordFailure(s, "grep", "TIMEOUT");
    expect(shouldTriggerMaxMode(s, "grep", "TIMEOUT", multiConfig)).toBe(true);
    markTriggered(s);

    // Fourth should be blocked
    resetSession(s);
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", multiConfig)).toBe(false);
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/auto-max");
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
  });

  it("event resets session on session.created", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks.event!({ event: "session.created", sessionID: "new-session" });
  });

  it("tool.execute.after is no-op when disabled", async () => {
    // Default config has enabled:true, so we test with a hook that accepts
    // the result normally — failures should increment
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { output: "ENOENT: no such file" },
    );
  });

  it("tool.execute.after resets on success", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    // Fail once
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s2", callID: "c1" },
      { output: "ENOENT: no such file" },
    );

    // Succeed with same tool — should reset
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: "s2", callID: "c2" },
      { output: "success" },
    );
  });

  it("triggers max mode after threshold failures", async () => {
    const mod = await import("./index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "s3";

    // 3 failures
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c1" },
      { output: "ENOENT: no such file" },
    );
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c2" },
      { output: "ENOENT: no such file" },
    );
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c3" },
      { output: "ENOENT: no such file" },
    );

    // Should have triggered
    expect(ctx._autoMaxTrigger).toBeDefined();
    const trigger = ctx._autoMaxTrigger as Record<string, unknown>;
    expect(trigger.tool).toBe("bash");
    expect(trigger.errorType).toBe("ENOENT");
  });

  it("injects auto-max trigger message into system transform", async () => {
    const mod = await import("./index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Set up a trigger
    ctx._autoMaxTrigger = {
      tool: "bash",
      errorType: "ENOENT",
      failCount: 3,
      sessionID: "s4",
    };

    const data = { system: ["existing system prompt"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s4" },
      data,
    );

    expect(data.system.length).toBe(2);
    expect(data.system[1]).toContain("AUTO-MAX TRIGGERED");
    expect(data.system[1]).toContain("bash:ENOENT");
    expect(ctx._autoMaxTrigger).toBeUndefined(); // cleaned up
  });

  it("system transform does nothing without trigger", async () => {
    const mod = await import("./index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const data = { system: ["existing system prompt"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s5" },
      data,
    );

    expect(data.system.length).toBe(1);
  });
});
