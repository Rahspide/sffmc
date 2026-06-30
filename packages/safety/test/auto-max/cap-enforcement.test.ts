// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE
//
// v0.14.1 regression test for Bug 2: auto-max cap=1/session was reported
// as not enforced in production — same session appeared to trigger 7 times
// during v0.14.0 release. After analysis, the cap mechanism in
// shouldTriggerMaxMode (coordinator.ts) IS enforced correctly via two
// redundant guards (`state.triggered` and `state.maxCallsThisSession >=
// config.costCapPerSession`). The production symptom was actually silent
// suppression: subsequent errors after the first trigger were dropped with
// no log line, so operators counted stale "TRIGGERED:" messages from
// earlier in the session and assumed the cap was bypassed.
//
// Fix: handleTrigger now emits an explicit "cap reached" log when the
// cap blocks a trigger, making the enforcement observable.

import { describe, it, expect, jest, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const testConfigDir = resolve(homedir(), ".config/SFFMC");
const testConfigPath = resolve(testConfigDir, "auto-max.yaml");

/**
 * Import the auto-max module with a cache-busting query string so the
 * module-level `loadedLogged` flag starts at `false`. This also gives
 * us a fresh PluginState Map (the `_autoMaxTrigger` and `sessions`
 * Maps are per-instance state).
 */
async function importFresh(suffix: string): Promise<typeof import("../src/auto-max/index")> {
  return await import(`../../src/auto-max/index.ts?cachebust=${Date.now()}-${suffix}`);
}

describe("Bug 2 fix — auto-max cap=1/session fires exactly ONCE", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;
  const triggerMessages: string[] = [];
  const capReachedMessages: string[] = [];

  beforeAll(() => {
    mkdirSync(testConfigDir, { recursive: true });
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    warnSpy = jest.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      const msg = args.map(a => typeof a === "string" ? a : "").join(" ");
      if (msg.includes("[auto-max] TRIGGERED:")) triggerMessages.push(msg);
      if (msg.includes("cap reached")) capReachedMessages.push(msg);
    });
  });

  afterAll(() => {
    if (warnSpy) warnSpy.mockRestore();
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  it("fires TRIGGERED exactly once with cap=1/session, subsequent errors are no-ops", async () => {
    const mod = await importFresh("cap1");

    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const sid = "bug2-cap-test";
    triggerMessages.length = 0;
    capReachedMessages.length = 0;

    // First wave — 3 bash failures to trip the trigger (threshold=3)
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `first-${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    // After the 3rd failure, the FIRST (and only) TRIGGERED should have fired.
    expect(triggerMessages.length).toBe(1);
    expect(triggerMessages[0]).toContain("bash:ENOENT");
    expect(triggerMessages[0]).toContain(sid);

    // Consume the trigger via system.transform (mirrors what the runtime does)
    const data = { system: ["existing"] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data);
    expect(data.system.length).toBe(2);
    expect(data.system[1]).toContain("AUTO-MAX TRIGGERED");

    // Second wave — 3 more bash failures with the same errorType
    // Cap must block ALL of these. No new TRIGGERED log lines.
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `second-${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    // Third wave — 10 MORE bash failures, all blocked by cap
    for (let i = 0; i < 10; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `third-${i}` },
        { output: "ENOENT: no such file" },
      );
    }

    // CRITICAL: only ONE TRIGGERED log line total for this session.
    // Bug 2 reproduced: production saw 7. This test must stay at 1.
    expect(triggerMessages.length).toBe(1);

    // The fix also makes cap-reached suppression observable.
    // Every blocked trigger attempt should emit a "cap reached" log so
    // operators can see the cap is firing (not that the trigger
    // accidentally went missing).
    expect(capReachedMessages.length).toBeGreaterThan(0);
    expect(capReachedMessages[0]).toContain("1/1");
    expect(capReachedMessages[0]).toContain("bash:ENOENT");
    expect(capReachedMessages[0]).toContain(sid);

    // system.transform after the cap-blocked failures must NOT inject
    // a 2nd AUTO-MAX fragment (the per-instance _autoMaxTrigger map was
    // already consumed).
    const data2 = { system: ["existing 2"] };
    await hooks["experimental.chat.system.transform"]!({ sessionID: sid }, data2);
    expect(data2.system.length).toBe(1);
  });

  it("triggers multiple times after /max reset within the same session (cap persists across resetSession)", async () => {
    // With cap=1, only 1 trigger fires per session. /max reset re-arms the
    // triggered flag (allowing next trigger) AND resets maxCallsThisSession
    // (clearing the cap). After /max reset, exactly 1 more trigger fires.
    const mod = await importFresh("cap1-reset");

    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const sid = "bug2-cap-reset";
    triggerMessages.length = 0;
    capReachedMessages.length = 0;

    // First trigger — 3 bash failures
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `r1-${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(triggerMessages.length).toBe(1);

    // Reset cap and triggered via /max
    await hooks["command.execute.before"]!({
      command: `/max reset ${sid}`,
      sessionID: "different-session",
    });

    // Second trigger — 3 more failures after reset
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `r2-${i}` },
        { output: "ENOENT: error" },
      );
    }
    expect(triggerMessages.length).toBe(2);

    // Third wave — blocked because cap (now 2/1) is exhausted
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `r3-${i}` },
        { output: "ENOENT: error" },
      );
    }

    // Still 2 triggers total (third wave blocked)
    expect(triggerMessages.length).toBe(2);
    // And cap-reached logs visible
    expect(capReachedMessages.length).toBeGreaterThan(0);
  });
});
