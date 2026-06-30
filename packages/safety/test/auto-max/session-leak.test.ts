// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE
//
// v0.14.10 regression test for Bug 3b: state.sessions Map was leaking
// forever in long-running daemons. resetSession clears inner counters
// (failCount, triggered) but does NOT delete the outer Map entry, so
// every unique sessionID permanently added a SessionState to
// state.sessions.
//
// Fix: SESSION_CREATED handler now deletes any existing entry then
// recreates fresh via getOrCreateSession, giving a true clean slate.
//
// These tests use the test-only _getSessionCount() helper on the hooks
// object to verify the Map stays bounded for repeated sessionIDs.

import { describe, it, expect, jest, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, unlinkSync, existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";

const testConfigDir = resolve(homedir(), ".config/SFFMC");
const testConfigPath = resolve(testConfigDir, "auto-max.yaml");

async function importFresh(suffix: string): Promise<typeof import("../src/auto-max/index")> {
  return await import(`../../src/auto-max/index.ts?cachebust=${Date.now()}-${suffix}`);
}

describe("Bug 3b fix — state.sessions Map stays bounded across SESSION_CREATED", () => {
  let warnSpy: ReturnType<typeof jest.spyOn>;

  beforeAll(() => {
    mkdirSync(testConfigDir, { recursive: true });
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterAll(() => {
    if (warnSpy) warnSpy.mockRestore();
    if (existsSync(testConfigPath)) unlinkSync(testConfigPath);
  });

  it("SESSION_CREATED with the same sessionID twice leaves state.sessions with 1 entry (not 2)", async () => {
    const mod = await importFresh("reuse-sid");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const sid = "bug3b-reuse-sid";
    expect(hooks._getSessionCount()).toBe(0);

    await hooks.event!({ event: "session.created", sessionID: sid });
    expect(hooks._getSessionCount()).toBe(1);

    // Reusing the same sessionID must NOT add another entry.
    await hooks.event!({ event: "session.created", sessionID: sid });
    expect(hooks._getSessionCount()).toBe(1);

    // Third reuse — still 1.
    await hooks.event!({ event: "session.created", sessionID: sid });
    expect(hooks._getSessionCount()).toBe(1);
  });

  it("SESSION_CREATED with different sessionIDs adds entries (existing behavior preserved)", async () => {
    const mod = await importFresh("distinct-sids");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    expect(hooks._getSessionCount()).toBe(0);

    await hooks.event!({ event: "session.created", sessionID: "alpha" });
    await hooks.event!({ event: "session.created", sessionID: "beta" });
    await hooks.event!({ event: "session.created", sessionID: "gamma" });

    expect(hooks._getSessionCount()).toBe(3);
  });

  it("SESSION_CREATED with reused sessionID resets cap so a fresh trigger can fire", async () => {
    // Pre-fix, resetSession cleared failCount + triggered but left
    // maxCallsThisSession at 1, which (with cap=1) blocked the next
    // trigger. Post-fix, the new SessionState has maxCallsThisSession=0,
    // so the cap is rearmed. This is observable via the TRIGGERED log.
    const mod = await importFresh("cap-rearm");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const triggerMessages: string[] = [];
    warnSpy.mockImplementation((...args: unknown[]) => {
      const msg = args.map(a => typeof a === "string" ? a : "").join(" ");
      if (msg.includes("[auto-max] TRIGGERED:")) triggerMessages.push(msg);
    });

    const sid = "bug3b-cap-rearm";

    // First lifecycle: create session, hit threshold, trigger fires.
    await hooks.event!({ event: "session.created", sessionID: sid });
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c1-${i}` },
        { output: "ENOENT: no such file" },
      );
    }
    expect(triggerMessages.length).toBe(1);

    // Reuse the same sessionID — fresh SessionState means cap is reset.
    await hooks.event!({ event: "session.created", sessionID: sid });

    // Second lifecycle: should fire a SECOND trigger because the new
    // SessionState has maxCallsThisSession=0 (not 1).
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `c2-${i}` },
        { output: "ENOENT: no such file" },
      );
    }
    expect(triggerMessages.length).toBe(2);

    // Map is still size 1 — no leak.
    expect(hooks._getSessionCount()).toBe(1);
  });

  it("SESSION_CREATED with reused sessionID clears inner failCount", async () => {
    // Observable: if we record 3 bash failures (failCount = 3), then
    // reuse the sessionID via SESSION_CREATED, then record ONE more
    // failure, failCount should be 1 (fresh). If the old state was
    // retained (failCount not cleared), it would be 4 — and a second
    // tool.execute.after would fire TRIGGERED. We assert no TRIGGERED
    // after the reset.
    const mod = await importFresh("fail-count-clear");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });

    const triggerMessages: string[] = [];
    warnSpy.mockImplementation((...args: unknown[]) => {
      const msg = args.map(a => typeof a === "string" ? a : "").join(" ");
      if (msg.includes("[auto-max] TRIGGERED:")) triggerMessages.push(msg);
    });

    const sid = "bug3b-clear-counts";

    await hooks.event!({ event: "session.created", sessionID: sid });
    for (let i = 0; i < 3; i++) {
      await hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: sid, callID: `a-${i}` },
        { output: "ENOENT" },
      );
    }
    expect(triggerMessages.length).toBe(1);

    // Reset via SESSION_CREATED.
    await hooks.event!({ event: "session.created", sessionID: sid });

    // One failure should NOT be enough to trigger (fresh failCount = 1).
    await hooks["tool.execute.after"]!(
      { tool: "bash", sessionID: sid, callID: "b-0" },
      { output: "ENOENT" },
    );
    expect(triggerMessages.length).toBe(1);

    // Map still size 1.
    expect(hooks._getSessionCount()).toBe(1);
  });
});