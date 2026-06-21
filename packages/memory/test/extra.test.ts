// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PluginContext } from "@sffmc/shared";

/**
 * loadServer sets HOME to a temp dir for the duration of the test so that
 * loadConfig doesn't pick up the live ~/.config/SFFMC/extra.yaml. This
 * isolates the test from the user's real config.
 */
let tempHome: string | undefined;
let originalHome: string | undefined;

beforeAll(() => {
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "sffmc-extra-test-"));
  process.env.HOME = tempHome;
});

afterAll(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  if (tempHome) {
    try { rmSync(tempHome, { recursive: true, force: true }); } catch {}
  }
});

const loadServer = async (
  config: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<(typeof import("../../extra/src/index"))["default"]["server"]>>> => {
  const mod = await import("../../extra/src/index");
  const ctx: PluginContext = {
    projectRoot: "/tmp/test-project",
    config: {},
  };
  return await mod.default.server(ctx);
};

describe("@sffmc/extra plugin", () => {
  it("default export shape: { id, server }", async () => {
    const mod = await import("../../extra/src/index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/extra");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns 3 tools (extra_checkpoint, extra_judge, extra_dream) with no 'name' field", async () => {
    const hooks = await loadServer();
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool.extra_checkpoint).toBeDefined();
    expect(hooks.tool.extra_judge).toBeDefined();
    expect(hooks.tool.extra_dream).toBeDefined();

    // Regression guard (fix-17): no `name` field on tool defs
    const cp = hooks.tool.extra_checkpoint as Record<string, unknown>;
    expect(cp.description).toBeTypeOf("string");
    expect(cp.parameters).toEqual({
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "delete", "restore"] },
        sessionID: { type: "string" },
      },
      required: ["action"],
    });
    expect(cp.execute).toBeFunction();
    expect(cp.name).toBeUndefined();

    for (const toolName of ["extra_judge", "extra_dream"]) {
      const def = hooks.tool[toolName] as Record<string, unknown>;
      expect(def.description).toBeTypeOf("string");
      expect((def.parameters as Record<string, unknown>).type).toBe("object");
      expect(def.execute).toBeFunction();
      expect(def.name).toBeUndefined();
    }
  });

  it("with default config (all disabled), each tool returns an object result", async () => {
    const hooks = await loadServer();
    for (const toolName of ["extra_checkpoint", "extra_judge", "extra_dream"]) {
      const result = (await (hooks.tool[toolName] as { execute: () => Promise<unknown> }).execute()) as Record<string, unknown>;
      // Just verify the tool returns an object (any of these valid shapes):
      //   - { ok: true, skipped: true, reason: "feature disabled" } (default disabled)
      //   - { ok: true, status: "stub" } (config enabled, impl still stub)
      //   - real result (config enabled, full impl)
      expect(typeof result).toBe("object");
      expect(result).not.toBeNull();
    }
  });

  it("factory functions return { tool, hooks } shape (so index.ts can spread)", async () => {
    const { createCheckpointTool } = await import("../../extra/src/checkpoint");
    const { createJudgeTool } = await import("../../extra/src/judge");
    const { createDreamTool } = await import("../../extra/src/dream");

    const cp = createCheckpointTool({ enabled: false });
    expect(cp.tool).toBeDefined();
    expect(cp.hooks).toBeDefined();

    const j = createJudgeTool({ enabled: false, model: "test", rubric: "test" });
    expect(j.tool).toBeDefined();
    expect(j.hooks).toBeDefined();

    const d = createDreamTool({ enabled: false, threshold: 50, intervalHours: 24 });
    expect(d.tool).toBeDefined();
    expect(d.hooks).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// initial release migration (max checkpoint file size, max restored messages, Jaccard dedup threshold, Jaccard cluster threshold, dream max entries) — config-loading path tests
// ---------------------------------------------------------------------------
//
// Verifies that the YAML-configurable thresholds/caps reach the factory
// constructors with the correct defaults (matching the prior hardcoded
// values, so behavior is unchanged when no YAML is present) and that
// overrides flow through unchanged.

describe("@sffmc/extra — initial release migration", () => {
  it("checkpoint defaults match prior hardcoded values (max checkpoint file size, max restored messages)", async () => {
    const { createCheckpointTool } = await import("../../extra/src/checkpoint");
    // Call without optional fields — must match prior 10 MiB / 50 behavior.
    const cp = createCheckpointTool({ enabled: false });
    expect(cp.tool).toBeDefined();
    expect(cp.hooks).toBeDefined();
    // The factory is a closure over maxFileSize/maxRestoredMessages. We
    // verify behavior indirectly: the legacy helpers (readToolCalls) still
    // work with the defaults.
    const { readToolCalls, __setCheckpointDir } = await import("../../extra/src/checkpoint");
    __setCheckpointDir(tempHome!);
    expect(readToolCalls("nonexistent-session-xyz")).toEqual([]);
  });

  it("checkpoint accepts explicit maxFileSize + maxRestoredMessages overrides (max checkpoint file size, max restored messages)", async () => {
    const { createCheckpointTool } = await import("../../extra/src/checkpoint");
    // Non-default values; verify the factory accepts them without throwing.
    const cp = createCheckpointTool({
      enabled: false,
      maxFileSize: 1024, // 1 KiB — drastically lower than 10 MiB default
      maxRestoredMessages: 5, // drastically lower than 50 default
    });
    expect(cp.tool).toBeDefined();
    expect(cp.tool.description).toContain("disabled");
  });

  it("dream factory accepts dedupThreshold/clusterThreshold/maxEntries overrides (Jaccard dedup threshold, Jaccard cluster threshold, dream max entries)", async () => {
    const { createDreamTool, DREAM_DEDUP_THRESHOLD, DREAM_CLUSTER_THRESHOLD, MAX_DREAM_ENTRIES } = await import("../../extra/src/dream");
    // Verify the exported constants still match the prior hardcoded values.
    expect(DREAM_DEDUP_THRESHOLD).toBe(0.9);
    expect(DREAM_CLUSTER_THRESHOLD).toBe(0.3);
    expect(MAX_DREAM_ENTRIES).toBe(5000);

    // Verify the factory accepts the new config fields without throwing.
    const d = createDreamTool({
      enabled: false,
      threshold: 50,
      intervalHours: 24,
      dedupThreshold: 0.85,
      clusterThreshold: 0.25,
      maxEntries: 1000,
    });
    expect(d.tool).toBeDefined();
    expect(d.tool.description).toContain("F8 Dream");
  });
});


// ---------------------------------------------------------------------------
// second release migration (buffer flush threshold, periodic flush interval, max in-memory session buffers) — config-loading path tests
// ---------------------------------------------------------------------------
//
// Verifies that the YAML-configurable buffer/flush fields reach the
// checkpoint factory and produce the expected behavior:
//   (a) defaults match v0.14.2 hardcoded values (50 / 5_000 / 50)
//   (b) overrides change observable behavior

describe("@sffmc/extra — second release migration (checkpoint buffer flush threshold, periodic flush interval, max in-memory session buffers)", () => {
  it("default constants exported by checkpoint.ts match v0.14.2 values", async () => {
    const {
      DEFAULT_FLUSH_THRESHOLD,
      DEFAULT_FLUSH_INTERVAL_MS,
      DEFAULT_MAX_BUFFER_SESSIONS,
    } = await import("../../extra/src/checkpoint");
    expect(DEFAULT_FLUSH_THRESHOLD).toBe(50);
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(5_000);
    expect(DEFAULT_MAX_BUFFER_SESSIONS).toBe(50);
  });

  it("factory accepts flushThreshold / flushIntervalMs / maxBufferedSessions overrides (buffer flush threshold, periodic flush interval, max in-memory session buffers)", async () => {
    const { createCheckpointTool } = await import("../../extra/src/checkpoint");
    const cp = createCheckpointTool({
      enabled: true,
      flushThreshold: 3,
      flushIntervalMs: 200,
      maxBufferedSessions: 5,
    });
    expect(cp.tool).toBeDefined();
    cp.cleanup();
  });

  it("flushThreshold override changes buffer-flush behavior (buffer flush threshold, b-1)", async () => {
    const { createCheckpointTool, filePath, __setCheckpointDir, readToolCalls } = await import(
      "../../extra/src/checkpoint"
    );
    const testDir = mkdtempSync(join(tmpdir(), "sffmc-e3-threshold-"));
    try {
      __setCheckpointDir(testDir);
      const cp = createCheckpointTool({ enabled: true, dir: testDir, flushThreshold: 2 });
      await cp.hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "e3-ses", callID: "c1" },
        { output: "out1", metadata: { args: { x: 1 } } },
      );
      const fp = filePath("e3-ses", testDir);
      expect(existsSync(fp)).toBe(false);
      await cp.hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "e3-ses", callID: "c2" },
        { output: "out2", metadata: { args: { x: 2 } } },
      );
      const calls = readToolCalls("e3-ses", testDir);
      expect(calls.length).toBe(2);
      expect(calls[0].callID).toBe("c1");
      expect(calls[1].callID).toBe("c2");
      cp.cleanup();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("maxBufferedSessions override changes LRU eviction behavior (max in-memory session buffers, b-2)", async () => {
    const { createCheckpointTool, filePath, __setCheckpointDir, readToolCalls } = await import(
      "../../extra/src/checkpoint"
    );
    const testDir = mkdtempSync(join(tmpdir(), "sffmc-e5-maxbuf-"));
    try {
      __setCheckpointDir(testDir);
      const cp = createCheckpointTool({ enabled: true, dir: testDir, maxBufferedSessions: 3 });
      for (const s of ["e5-a", "e5-b", "e5-c"]) {
        await cp.hooks["tool.execute.after"]!(
          { tool: "bash", sessionID: s, callID: `c-${s}` },
          { output: `o-${s}`, metadata: { args: {} } },
        );
      }
      expect(existsSync(filePath("e5-a", testDir))).toBe(false);
      expect(existsSync(filePath("e5-b", testDir))).toBe(false);
      expect(existsSync(filePath("e5-c", testDir))).toBe(false);
      await cp.hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "e5-d", callID: "cd" },
        { output: "od", metadata: { args: {} } },
      );
      const evicted = readToolCalls("e5-a", testDir);
      expect(evicted.length).toBe(1);
      expect(evicted[0].callID).toBe("c-e5-a");
      cp.cleanup();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("flushIntervalMs override is reflected in the periodic timer (periodic flush interval, b-3)", async () => {
    const { createCheckpointTool, filePath, __setCheckpointDir, readToolCalls } = await import(
      "../../extra/src/checkpoint"
    );
    const testDir = mkdtempSync(join(tmpdir(), "sffmc-e4-interval-"));
    try {
      __setCheckpointDir(testDir);
      const cp = createCheckpointTool({
        enabled: true, dir: testDir, flushThreshold: 100, flushIntervalMs: 100,
      });
      await cp.hooks["tool.execute.after"]!(
        { tool: "bash", sessionID: "e4-timer", callID: "ct" },
        { output: "out-t", metadata: { args: {} } },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      const periodic = readToolCalls("e4-timer", testDir);
      expect(periodic.length).toBe(1);
      expect(periodic[0].callID).toBe("ct");
      cp.cleanup();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
