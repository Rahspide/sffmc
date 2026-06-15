// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE

import { describe, it, expect, beforeAll } from "bun:test";
import { type PluginContext } from "@sffmc/shared";

const loadServer = async (
  config: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<(typeof import("./index"))["default"]["server"]>>> => {
  // Bypass loadConfig (which reads from disk) by mocking ~/.config/SFFMC/extra.yaml
  // Since the test runs in a clean env, loadConfig returns defaultConfig.
  // To test specific config values, we need to write the config file or
  // restructure to allow injection. For now, test default behavior.
  const mod = await import("./index");
  const ctx: PluginContext = {
    projectRoot: "/tmp/test-project",
    config: {},
  };
  return await mod.default.server(ctx);
};

describe("@sffmc/extra plugin", () => {
  it("default export shape: { id, server }", async () => {
    const mod = await import("./index");
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
    // extra_checkpoint has real parameters (action, sessionID); judge/dream are stubs with empty props
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
      // Tools may have varying parameter schemas; just verify type is "object"
      expect((def.parameters as Record<string, unknown>).type).toBe("object");
      expect(def.execute).toBeFunction();
      expect(def.name).toBeUndefined();
    }
  });

  it("with default config (all disabled), each tool returns { ok: true, skipped: true, reason: 'feature disabled' }", async () => {
    const hooks = await loadServer();
    for (const toolName of ["extra_checkpoint", "extra_judge", "extra_dream"]) {
      const result = (await (hooks.tool[toolName] as { execute: () => Promise<unknown> }).execute()) as Record<string, unknown>;
      expect(result).toMatchObject({ ok: true, skipped: true, reason: "feature disabled" });
    }
  });

  it("factory functions return { tool, hooks } shape (so index.ts can spread)", async () => {
    const { createCheckpointTool } = await import("./checkpoint");
    const { createJudgeTool } = await import("./judge");
    const { createDreamTool } = await import("./dream");

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
