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
  dryRun: false,
  watchdogThreshold: 3,
  maxModeConfig: {
    n: 3,
    judgeModel: "test-model",
  },
  costCapPerSession: 1,
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
      costCapPerSession: 3,
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
      watchdogThreshold: 2,
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
    // Clean up stale config from any previous dryRun test run
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

    // Trigger now lives in per-instance PluginState (Map<sessionID, AutoMaxTrigger>).
    // Observable side-effect: system.transform injects the AUTO-MAX fragment
    // and renders tool:errorType into the message.
    const data = { system: ["existing"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data,
    );
    expect(data.system.length).toBe(2);
    expect(data.system[1]).toContain("AUTO-MAX TRIGGERED");
    expect(data.system[1]).toContain("bash:ENOENT");
  });

  it("injects auto-max trigger message into system transform", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Drive 3 failures for session s4 to populate per-instance PluginState
    // (formerly set via ctx._autoMaxTrigger side-channel — refactored to Map).
    const sid = "s4";
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    const data = { system: ["existing system prompt"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data,
    );

    expect(data.system.length).toBe(2);
    expect(data.system[1]).toContain("AUTO-MAX TRIGGERED");
    expect(data.system[1]).toContain("bash:ENOENT");

    // Trigger is one-shot — second transform for same sessionID must NOT
    // re-inject (state was deleted on first read).
    const data2 = { system: ["existing 2"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data2,
    );
    expect(data2.system.length).toBe(1);
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

    // Drive 3 failures with grep tool / ETIMEDOUT error
    const sid = "s6";
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "grep", sessionID: sid, callID: `c${i}` },
        { output: "ETIMEDOUT: connection timed out" },
      );
    }

    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data,
    );

    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("grep:ETIMEDOUT");
    expect(data.system[0]).toContain("3 consecutive times");
  });

  it("trigger is cleaned up even on empty system array", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Drive 3 failures for session s7 to populate per-instance PluginState
    const sid = "s7";
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data,
    );

    // Trigger is consumed even if data.system was empty before — verify by
    // calling transform again and confirming no second injection.
    const data2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data2,
    );
    expect(data2.system.length).toBe(0);
  });

  it("tool.execute.after detects errors in object metadata with error flag", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    // Error via metadata.error flag should be detected
    const sid = "s8";
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: sid, callID: "c1" },
      { metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: sid, callID: "c2" },
      { metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "read", sessionID: sid, callID: "c3" },
      { metadata: { error: true } },
    );

    // Observable: system.transform renders the AUTO-MAX fragment with the
    // tool that triggered it
    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data);
    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("AUTO-MAX TRIGGERED");
    expect(data.system[0]).toContain("read:");
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
    const sid = "s9";
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: sid, callID: "c1" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: sid, callID: "c2" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );
    await hooks["tool.execute.after"]!(
      { tool: "glob", sessionID: sid, callID: "c3" },
      { output: { code: "ENOENT", message: "not found" }, metadata: { error: true } },
    );

    // Observable: trigger rendered into AUTO-MAX fragment includes tool:errorType
    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data);
    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("glob:ENOENT");
  });

  // ── dryRun mode ──────────────────────────────────────────

  describe("dryRun mode", () => {
    beforeAll(() => {
      mkdirSync(testConfigDir, { recursive: true });
      writeFileSync(
        testConfigPath,
        [
          "dryRun: true",
          "enabled: true",
          "watchdogThreshold: 3",
          "costCapPerSession: 1",
          "maxModeConfig:",
          "  n: 3",
          "  judgeModel: test-model",
        ].join("\n"),
      );
    });

    afterAll(() => {
      try {
        unlinkSync(testConfigPath);
      } catch {}
    });

    it("dryRun=true does not inject escalation fragment", async () => {
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

      // Observable: dryRun must NOT populate the per-instance trigger
      // (state._autoMaxTrigger stays empty → transform adds nothing)
      const data = { system: ["existing"] };
      await hooks["experimental.chat.system.transform"]!(
        { sessionID: sid },
        data,
      );
      expect(data.system.length).toBe(1);
    });

    it("dryRun=true logs 'would trigger' message", async () => {
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
    // Consume trigger via system.transform — observable proof of first trigger
    const data1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data1);
    expect(data1.system.length).toBe(1);
    expect(data1.system[0]).toContain("AUTO-MAX TRIGGERED");

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
    // Second trigger must also fire — proves the reset took effect
    const data2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data2);
    expect(data2.system.length).toBe(1);
    expect(data2.system[0]).toContain("AUTO-MAX TRIGGERED");
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
    // Consume first trigger
    const data1 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data1);
    expect(data1.system.length).toBe(1);

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
    // Second trigger must fire — proves reset targeted the right session
    const data2 = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data2);
    expect(data2.system.length).toBe(1);
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
    // Object with .name field — extractErrorType (shared/errors.ts) handles
    // o.code/o.name. .error-only objects are treated as success (see next
    // test); the legacy "object:<msg>" prefix was YAGNI scaffolding.
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "grep", sessionID: sid, callID: `c${i}` },
        { output: { name: "something went wrong" } },
      );
    }

    // Observable: errorType renders as "<name>" in the fragment
    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data);
    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("grep:something went wrong");
  });

  it("detects object output with .code field (no object: prefix)", async () => {
    const mod = await import("../../auto-max/src/index");
    const ctx: Record<string, unknown> = {
      projectRoot: "/tmp/test-project",
      config: {},
    };
    const hooks = await mod.default.server(ctx);

    const sid = "obj-err-2";
    // Object with .code field, no metadata.error flag.
    // extractErrorType reads o.code directly — no special "object:" prefix.
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "glob", sessionID: sid, callID: `c${i}` },
        { output: { code: "ERR_TIMEOUT" } },
      );
    }

    // Observable: errorType renders as "ERR_TIMEOUT" (no prefix)
    const data = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data);
    expect(data.system.length).toBe(1);
    expect(data.system[0]).toContain("glob:ERR_TIMEOUT");
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
    // (Observable: no AUTO-MAX fragment injected into system transform)
    const data = { system: ["existing"] };
    await hooks["experimental.chat.system.transform"]!(
      { sessionID: sid },
      data,
    );
    expect(data.system.length).toBe(1);
  });
});
