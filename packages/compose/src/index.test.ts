import { describe, it, expect } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");

const VALID_SKILLS = [
  "ask",
  "brainstorm",
  "debug",
  "execute",
  "feedback",
  "merge",
  "new-skill",
  "parallel",
  "plan",
  "report",
  "review",
  "subagent",
  "tdd",
  "verify",
  "worktree",
];

describe("Skill file integrity", () => {
  for (const name of VALID_SKILLS) {
    it(`skills/${name}.md exists and is non-empty (>100 bytes)`, async () => {
      const filePath = join(SKILLS_DIR, `${name}.md`);
      const content = await readFile(filePath, "utf-8");
      expect(content.length).toBeGreaterThan(100);
      // Attribution header present
      expect(content).toContain("Copied verbatim from XiaomiMiMo/MiMo-Code");
    });
  }
});

describe("Plugin entry smoke test", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/compose");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected tool shape", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool.compose_skill).toBeDefined();
    expect(typeof hooks.tool.compose_skill.execute).toBe("function");
  });

  it("compose_skill.execute returns markdown content for verify", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    const content = await hooks.tool.compose_skill.execute({ name: "verify" });
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(100);
    expect(content.trimStart().startsWith("<!-- Copied")).toBe(true);
  });

  it("compose_skill.execute returns content starting with # for plan", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    const content = await hooks.tool.compose_skill.execute({ name: "plan" });
    // After HTML comment, markdown content should have a header
    expect(content).toContain("# Writing Plans");
  });

  it("compose_skill.execute returns error for unknown skill", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    const content = await hooks.tool.compose_skill.execute({ name: "nonexistent" });
    expect(content).toContain("Error: Unknown skill");
  });
});
