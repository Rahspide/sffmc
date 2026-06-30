import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { readFile, rename, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SKILLS_DIR = join(import.meta.dirname, "..", "..", "compose", "skills");

const VALID_SKILLS = [
  "ask",
  "audit-deps",
  "benchmark",
  "brainstorm",
  "code-review",
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
    const mod = await import("../../compose/src/index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/cognition");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns expected tool shape", async () => {
    const mod = await import("../../compose/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool.compose_skill).toBeDefined();
    expect(typeof hooks.tool.compose_skill.execute).toBe("function");
  });

  it("compose_skill.execute returns markdown content for verify", async () => {
    const mod = await import("../../compose/src/index");
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
    const mod = await import("../../compose/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    const content = await hooks.tool.compose_skill.execute({ name: "plan" });
    // After HTML comment, markdown content should have a header
    expect(content).toContain("# Writing Plans");
  });

  it("compose_skill.execute returns error for unknown skill", async () => {
    const mod = await import("../../compose/src/index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    const content = await hooks.tool.compose_skill.execute({ name: "nonexistent" });
    expect(content).toContain("Error: Unknown skill");
  });
});

describe("compose_skill argument validation", () => {
  let hooks: Awaited<ReturnType<typeof import("../../compose/src/index").default.server>>;

  beforeAll(async () => {
    const mod = await import("../../compose/src/index");
    hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
  });

  it("rejects empty string name", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "" });
    expect(content).toBe("Error: skill name is required");
  });

  it("rejects whitespace-only name", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "   " });
    expect(content).toContain("Error: Unknown skill");
  });

  it("rejects name with special characters", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "rm -rf /" });
    expect(content).toContain("Error: Unknown skill");
    expect(content).toContain("Valid skills:");
  });

  it("rejects numeric name", async () => {
    // TypeScript would reject this at compile time, but runtime behavior is tested
    const content = await hooks.tool.compose_skill.execute({ name: 123 as unknown as string });
    expect(content).toBe("Error: skill name is required");
  });

  it("rejects null name", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: null as unknown as string });
    expect(content).toBe("Error: skill name is required");
  });

  it("rejects undefined name", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: undefined as unknown as string });
    expect(content).toBe("Error: skill name is required");
  });

  it("rejects object as name", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: { x: 1 } as unknown as string });
    expect(content).toBe("Error: skill name is required");
  });
});

describe("compose_skill corrupted file handling", () => {
  const skillName = "new-skill";
  const skillFile = join(SKILLS_DIR, `${skillName}.md`);
  const backupFile = join(SKILLS_DIR, `${skillName}.md.bak.test`);

  let hooks: Awaited<ReturnType<typeof import("../../compose/src/index").default.server>>;

  beforeAll(async () => {
    // Clean up any orphaned backup from a previous interrupted run
    await rm(backupFile, { force: true });
    // Backup the real skill file
    await rename(skillFile, backupFile);
    const mod = await import("../../compose/src/index");
    hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
  });

  afterAll(async () => {
    // Remove the corrupted file (could be file or directory)
    await rm(skillFile, { force: true, recursive: true });
    // Restore the original skill file
    await rename(backupFile, skillFile);
  });

  it("returns graceful error for empty file content", async () => {
    await writeFile(skillFile, "");
    const content = await hooks.tool.compose_skill.execute({ name: skillName });
    expect(content).toBe("Error: skill 'new-skill' is empty (file has no content)");
  });

  it("returns graceful error when readFile throws on a directory", async () => {
    // Simulate a corrupted "file" that is actually a directory
    await rm(skillFile, { force: true });
    await mkdir(skillFile);
    const content = await hooks.tool.compose_skill.execute({ name: skillName });
    expect(content).toContain("Error: failed to load skill 'new-skill'");
    expect(content).toContain("EISDIR");
  });
});

describe("compose_skill full coverage", () => {
  let hooks: Awaited<ReturnType<typeof import("../../compose/src/index").default.server>>;

  beforeAll(async () => {
    const mod = await import("../../compose/src/index");
    hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
  });

  it("all 18 valid skills return content > 100 chars", async () => {
    for (const name of VALID_SKILLS) {
      const content = await hooks.tool.compose_skill.execute({ name });
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(100);
    }
  });

  it("concurrent skill reads complete without interference", async () => {
    const results = await Promise.all(
      VALID_SKILLS.map((name) => hooks.tool.compose_skill.execute({ name })),
    );
    // All 18 resolved without throwing
    expect(results.length).toBe(18);
    for (let i = 0; i < VALID_SKILLS.length; i++) {
      expect(typeof results[i]).toBe("string");
      expect(results[i].length).toBeGreaterThan(100);
    }
    // Determinism: a parallel call for skill[i] returns the same content
    // as a single call. This proves no cross-skill state contamination.
    for (const name of VALID_SKILLS.slice(0, 3)) {
      const single = await hooks.tool.compose_skill.execute({ name });
      const idx = VALID_SKILLS.indexOf(name);
      expect(single).toBe(results[idx]);
    }
  });

  it("works with minimal context", async () => {
    const mod = await import("../../compose/src/index");
    const h = await mod.default.server({ projectRoot: "/", config: {} });
    const content = await h.tool.compose_skill.execute({ name: "ask" });
    expect(content.length).toBeGreaterThan(100);
  });

  it("verify skill has expected structure", async () => {
    for (const name of VALID_SKILLS) {
      const content = await hooks.tool.compose_skill.execute({ name });
      // Every skill file should start with an HTML comment
      expect(content.trimStart()).toMatch(/^<!--/);
    }
  });

  it("verify skill contains verification-specific keywords", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "verify" });
    expect(content).toContain("Copied verbatim from XiaomiMiMo/MiMo-Code");
    // Verify skill should reference verification concepts
    expect(content.toLowerCase()).toMatch(/verif|review|check|test/);
  });

  it("tdd skill contains TDD workflow keywords", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "tdd" });
    expect(content).toContain("Copied verbatim from XiaomiMiMo/MiMo-Code");
    expect(content.toLowerCase()).toMatch(/test|tdd|red.*green|refactor/);
  });

  it("each skill name appears in its own content", async () => {
    for (const name of VALID_SKILLS) {
      const content = await hooks.tool.compose_skill.execute({ name });
      // Skill file markdown should mention the skill name or mode
      expect(content.toLowerCase()).toContain(name.toLowerCase());
    }
  });

  it("unknown skill error lists all valid names", async () => {
    const content = await hooks.tool.compose_skill.execute({ name: "foobar" });
    expect(content).toContain("Error: Unknown skill");
    for (const name of VALID_SKILLS) {
      expect(content).toContain(name);
    }
  });
});

describe("compose_skill tool description", () => {
  let hooks: Awaited<ReturnType<typeof import("../../compose/src/index").default.server>>;

  beforeAll(async () => {
    const mod = await import("../../compose/src/index");
    hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
  });

  it("description mentions skill names and purpose", () => {
    const desc = hooks.tool.compose_skill.description;
    // Description references at least some skill names
    expect(desc).toContain("verify");
    expect(desc).toContain("tdd");
    expect(desc).toContain("plan");
    expect(desc).toContain("etc");
    expect(desc).toMatch(/Compose Mode/);
  });

  it("parameters include name field with type string", () => {
    const params = hooks.tool.compose_skill.parameters as Record<string, unknown>;
    expect(params.name).toBeDefined();
    expect((params.name as Record<string, unknown>).type).toBe("string");
  });
});
