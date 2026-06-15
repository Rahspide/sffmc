// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
): Promise<Awaited<ReturnType<(typeof import("./index"))["default"]["server"]>>> => {
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
