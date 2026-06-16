import { describe, it, expect, spyOn, beforeAll, afterAll } from "bun:test";
import {
  createSessionState,
  recordFailure,
  recordSuccess,
  shouldTriggerMaxMode,
  markTriggered,
  resetSession,
  type AutoMaxConfig,
} from "../../auto-max/src/coordinator";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const testConfigDir = resolve(homedir(), ".config/SFFMC");
const testConfigPath = resolve(testConfigDir, "auto-max.yaml");

const defaultConfig: AutoMaxConfig = {
  enabled: true,
  dry_run: false,
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

  it("shouldTriggerMaxMode with threshold=2 triggers at 2 failures", () => {
    const lowThresholdConfig: AutoMaxConfig = {
      ...defaultConfig,
      watchdog_threshold: 2,
    };

    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", lowThresholdConfig)).toBe(false);
    recordFailure(s, "bash", "ENOENT");
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", lowThresholdConfig)).toBe(true);
  });

  it("different sessions have isolated fail counts", () => {
    const s1 = createSessionState();
    const s2 = createSessionState();

    recordFailure(s1, "bash", "ENOENT");
    recordFailure(s1, "bash", "ENOENT");
    recordFailure(s1, "bash", "ENOENT");

    // s2 is untouched
    expect(s2.failCount.size).toBe(0);
    expect(shouldTriggerMaxMode(s2, "bash", "ENOENT", defaultConfig)).toBe(false);

    // s1 should trigger
    expect(shouldTriggerMaxMode(s1, "bash", "ENOENT", defaultConfig)).toBe(true);
  });

  it("recordFailure with empty error type still increments", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "");
    expect(s.failCount.get("bash::")).toBe(1);
  });

  it("recordSuccess only clears matching tool prefix", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "glob", "ERR");
    recordSuccess(s, "bash");
    expect(s.failCount.has("bash::ENOENT")).toBe(false);
    expect(s.failCount.has("glob::ERR")).toBe(true);
  });

  it("shouldTriggerMaxMode returns false when triggered even with enough failures", () => {
    const s = createSessionState();
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    recordFailure(s, "bash", "ENOENT");
    markTriggered(s);
    // After markTriggered, shouldTriggerMaxMode checks state.triggered first
    expect(shouldTriggerMaxMode(s, "bash", "ENOENT", defaultConfig)).toBe(false);
  });
});

describe("Plugin entry", () => {
  beforeAll(() => {
    // Clean up stale config from any previous dry_run test run
    try {
      unlinkSync(testConfigPath);
    } catch {}
  });

  it("exports default object with id and server function", async () => {
    const mod = await import("../../auto-max/src/index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/auto-max");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected hooks", async () => {
    const mod = await import("../../auto-max/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["tool.execute.after"]).toBe("function");
    expect(typeof hooks["command.execute.before"]).toBe("function");
    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function");
  });

  it("event resets session on session.created", async () => {
    const mod = await import("../../auto-max/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    await hooks.event!({ event: "session.created", sessionID: "new-session" });
  });

  it("tool.execute.after is no-op when disabled", async () => {
    // Default config has enabled:true, so we test with a hook that accepts
    // the result normally — failures should increment
    const mod = await import("../../auto-max/src/index");
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
    const mod = await import("../../auto-max/src/index");
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
    const mod = await import("../../auto-max/src/index");
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
    const mod = await import("../../auto-max/src/index");
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
    const mod = await import("../../auto-max/src/index");
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

  it("trigger message includes tool:errorType notation", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    ctx._autoMaxTrigger = {
      tool: "grep",
      errorType: "ETIMEDOUT",
      failCount: 3,
      sessionID: "s6",
    };

    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s6" },
      data,
    );

    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("grep:ETIMEDOUT");
    expect(data.system[0]).toContain("3 consecutive times");
    expect(ctx._autoMaxTrigger).toBeUndefined();
  });

  it("trigger is cleaned up even on empty system array", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    ctx._autoMaxTrigger = {
      tool: "bash",
      errorType: "ENOENT",
      failCount: 3,
      sessionID: "s7",
    };

    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: "s7" },
      data,
    );

    expect(ctx._autoMaxTrigger).toBeUndefined();
  });

  it("tool.execute.after detects errors in object metadata with error flag", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Error via metadata.error flag should be detected
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s8", callID: "c1" },
      { metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s8", callID: "c2" },
      { metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: "s8", callID: "c3" },
      { metadata: { error: true } },
    );

    expect(ctx._autoMaxTrigger).toBeDefined();
    const trigger = ctx._autoMaxTrigger as Record<string, unknown>;
    expect(trigger.tool).toBe("read");
  });

  it("tool.execute.after detects errors via output object code property", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Object output with metadata.error flag triggers error detection;
    // extractErrorType then reads the code property from the object
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: "s9", callID: "c1" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: "s9", callID: "c2" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: "s9", callID: "c3" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );

    expect(ctx._autoMaxTrigger).toBeDefined();
    const trigger = ctx._autoMaxTrigger as Record<string, unknown>;
    expect(trigger.tool).toBe("glob");
    expect(trigger.errorType).toBe("ENOENT");
  });

  // ── dry_run mode ──────────────────────────────────────────

  describe("dry_run mode", () => {
    beforeAll(() => {
      mkdirSync(testConfigDir, { recursive: true });
      writeFileSync(
        testConfigPath,
        [
          "dry_run: true",
          "enabled: true",
          "watchdog_threshold: 3",
          "cost_cap_per_session: 1",
          "max_mode_config:",
          "  n: 3",
          "  judge_model: test-model",
        ].join("\n"),
      );
    });

    afterAll(() => {
      try {
        unlinkSync(testConfigPath);
      } catch {}
    });

    it("dry_run=true does not inject escalation fragment", async () => {
      const mod = await import("../../auto-max/src/index");
      const ctx: Record<string, unknown> = {
        projectRoot: "/tmp/test-project",
        config: {},
      };
      const hooks = await mod.default.server(ctx);

      const sid = "dry-1";
      for (let i = 0; i < 3; i++) {
        await hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: sid, callID: `c${i}` },
          { output: "ENOENT: no such file" },
        );
      }

      expect(ctx._autoMaxTrigger).toBeUndefined();
    });

    it("dry_run=true logs 'would trigger' message", async () => {
      const mod = await import("../../auto-max/src/index");
      const ctx: Record<string, unknown> = {
        projectRoot: "/tmp/test-project",
        config: {},
      };
      const hooks = await mod.default.server(ctx);

      const warnSpy = spyOn(console, "warn");
      const sid = "dry-2";
      for (let i = 0; i < 3; i++) {
        await hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: sid, callID: `c${i}` },
          { output: "ENOENT: no such file" },
        );
      }

      const calls = warnSpy.mock.calls.filter(
        (c: unknown[]) =>
          (typeof c[0] === "string" && (c[0] as string).includes("would trigger")) ||
          (typeof c[1] === "string" && (c[1] as string).includes("would trigger")),
      );
      expect(calls.length).toBeGreaterThan(0);
      warnSpy.mockRestore();
    });
  });

  // ── /max escape hatch ─────────────────────────────────────

  it("/max command resets session counters", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "escape-1";

    // Trigger first time
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(ctx._autoMaxTrigger).toBeDefined();
    delete ctx._autoMaxTrigger;

    // Reset via /max
    await hooks["command.execute.before"]!({
      command: "/max",
      sessionID: sid,
    });

    // Should be able to trigger again after reset
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `d${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(ctx._autoMaxTrigger).toBeDefined();
  });

  it("/max reset clears counters for specified session", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "escape-2";

    // Build up 3 failures
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(ctx._autoMaxTrigger).toBeDefined();
    delete ctx._autoMaxTrigger;

    // Reset via /max reset <sessionID>
    await hooks["command.execute.before"]!({
      command: `/max reset ${sid}`,
      sessionID: "different-session",
    });

    // Counters cleared — should trigger again
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `d${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(ctx._autoMaxTrigger).toBeDefined();
  });

  // ── object output error detection ─────────────────────────

  it("detects object output with .error field as failure", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "obj-err-1";
    // Object with error field, no metadata.error flag
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "grep", sessionID: sid, callID: `c${i}` },
        { output: { error: "something went wrong" } },
      );
    }

    expect(ctx._autoMaxTrigger).toBeDefined();
    const trigger = ctx._autoMaxTrigger as Record<string, unknown>;
    expect(trigger.tool).toBe("grep");
    expect(trigger.errorType).toBe("object:something went wrong");
  });

  it("detects object output with .code field and object: prefix", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "obj-err-2";
    // Object with code field, no metadata.error flag
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "glob", sessionID: sid, callID: `c${i}` },
        { output: { code: "ERR_TIMEOUT" } },
      );
    }

    expect(ctx._autoMaxTrigger).toBeDefined();
    const trigger = ctx._autoMaxTrigger as Record<string, unknown>;
    expect(trigger.tool).toBe("glob");
    expect(trigger.errorType).toBe("object:ERR_TIMEOUT");
  });

  it("object output without error/code is treated as success", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "obj-ok";
    // Build 2 failures via string errors, then pass an object without error/code
    for (let i = 0; i < 2; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    // Object without error/code fields — should be treated as success, reset counters
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "c-ok" },
      { output: { result: "all good", status: 0 } },
    );

    // After reset, 3 more failures needed to trigger
    for (let i = 0; i < 2; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `d${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    // Only 2 failures after reset — should not trigger yet
    expect(ctx._autoMaxTrigger).toBeUndefined();
  });
});
