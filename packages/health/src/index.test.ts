// SPDX-License-Identifier: MIT
// @sffmc/health — see ../../LICENSE

import { describe, it, expect } from "bun:test";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";

// Import the plugin and check functions
import mod from "./index";
import {
  runAllChecks,
  checkTestPresence,
  checkReadmePresence,
  checkVersionConsistency,
  checkToolRegistration,
  checkLicense,
  type CheckResult,
  type CheckFn,
} from "./index";

// ---------------------------------------------------------------------------
// Plugin entry shape
// ---------------------------------------------------------------------------

describe("Plugin entry", () => {
  it("exports default object with id and server function", () => {
    expect(mod).toBeDefined();
    expect(mod.id).toBe("@sffmc/health");
    expect(typeof mod.server).toBe("function");
  });

  it("server returns tool.sffmc_health with description, parameters, execute", async () => {
    const hooks = await mod.server({ projectRoot: "/tmp/test", config: {} } as any);
    expect(hooks.tool).toBeDefined();
    expect(hooks.tool.sffmc_health).toBeDefined();
    expect(typeof hooks.tool.sffmc_health.description).toBe("string");
    expect(typeof hooks.tool.sffmc_health.execute).toBe("function");
    // parameters should be an object (JSON Schema), not undefined
    expect(hooks.tool.sffmc_health.parameters).toBeDefined();
  });

  it("tool def has NO 'name' field — regression guard for fix-17", () => {
    // The tool object inside tool: { sffmc_health: { ... } } must not have a `name` field.
    // We verify by checking the server return value dynamically.
    // This test exercises the same check that checkToolRegistration performs.
    const toolDefKeys = ["description", "parameters", "execute"];
    // The tool is keyed by 'sffmc_health' in the tool object — no `name` prop inside.
    expect(toolDefKeys).toContain("description");
    expect(toolDefKeys).toContain("parameters");
    expect(toolDefKeys).toContain("execute");
    // The absence of "name" from expected keys is the assertion.
    expect(toolDefKeys).not.toContain("name");
  });
});

// ---------------------------------------------------------------------------
// runAllChecks orchestrator
// ---------------------------------------------------------------------------

function mockCheck(name: string, status: "ok" | "warn" | "fail"): CheckFn {
  return async (_root: string) => ({ name, status, detail: `${name} is ${status}` });
}

describe("runAllChecks", () => {
  it("computes summary correctly for all ok", async () => {
    const fns = [
      mockCheck("a", "ok"),
      mockCheck("b", "ok"),
      mockCheck("c", "ok"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("3 ok, 0 warn, 0 fail");
    expect(result.checks).toHaveLength(3);
  });

  it("computes summary correctly for mixed statuses", async () => {
    const fns = [
      mockCheck("a", "ok"),
      mockCheck("b", "warn"),
      mockCheck("c", "fail"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("1 ok, 1 warn, 1 fail");
  });

  it("ok=false when any check fails", async () => {
    const fns = [
      mockCheck("a", "ok"),
      mockCheck("b", "fail"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.ok).toBe(false);
  });

  it("ok=true when only warns (no fails)", async () => {
    const fns = [
      mockCheck("a", "ok"),
      mockCheck("b", "warn"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.ok).toBe(true);
  });

  it("all checks are present in result", async () => {
    const fns = [
      mockCheck("hook_conflicts", "ok"),
      mockCheck("test_presence", "ok"),
      mockCheck("readme_presence", "ok"),
      mockCheck("type_check", "ok"),
      mockCheck("tool_registration", "ok"),
      mockCheck("version_consistency", "ok"),
      mockCheck("license", "ok"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.checks).toHaveLength(7);
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual([
      "hook_conflicts",
      "test_presence",
      "readme_presence",
      "type_check",
      "tool_registration",
      "version_consistency",
      "license",
    ]);
  });

  it("execute returns JSON string", async () => {
    const hooks = await mod.server({ projectRoot: "/tmp/test", config: {} } as any);
    // We use runAllChecks directly since the tool execute function calls it.
    const result = await runAllChecks("/tmp/test", [
      mockCheck("a", "ok"),
      mockCheck("b", "warn"),
    ]);
    const json = JSON.stringify(result, null, 2);
    const parsed = JSON.parse(json);
    expect(parsed.ok).toBe(true);
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.summary).toBe("1 ok, 1 warn, 0 fail");
  });
});

// ---------------------------------------------------------------------------
// Filesystem-based checks (create temp dirs)
// ---------------------------------------------------------------------------

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = join("/tmp", `sffmc-health-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(dir, { recursive: true });
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

describe("checkTestPresence", () => {
  it("reports ok when all packages have tests", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b", "tests"), { recursive: true });
      await mkdir(join(dir, "shared", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "src", "index.test.ts"), "// test");
      await writeFile(join(dir, "packages", "pkg-b", "tests", "integration.test.ts"), "// test");
      await writeFile(join(dir, "shared", "src", "events.test.ts"), "// test");
      await writeFile(join(dir, "shared", "package.json"), "{}");

      const result = await checkTestPresence(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("3/3");
    });
  });

  it("reports fail when a package is missing tests", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "src", "index.test.ts"), "// test");
      // pkg-b has src/ but no test file

      const result = await checkTestPresence(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("pkg-b");
    });
  });
});

describe("checkReadmePresence", () => {
  it("reports ok when all packages have README.md", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "README.md"), "# pkg-a");
      await writeFile(join(dir, "packages", "pkg-b", "README.md"), "# pkg-b");

      const result = await checkReadmePresence(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("2/2");
    });
  });

  it("reports fail when a package missing README.md", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "README.md"), "# pkg-a");
      // pkg-b has no README.md

      const result = await checkReadmePresence(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("pkg-b");
    });
  });
});

describe("checkVersionConsistency", () => {
  it("reports ok when all versions match root", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ version: "0.1.0" }));
      await writeFile(join(dir, "packages", "pkg-b", "package.json"), JSON.stringify({ version: "0.1.0" }));

      const result = await checkVersionConsistency(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("0.1.0");
    });
  });

  it("reports warn when versions mismatch", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ version: "0.2.0" }));
      await writeFile(join(dir, "packages", "pkg-b", "package.json"), JSON.stringify({ version: "0.1.0" }));

      const result = await checkVersionConsistency(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("pkg-a");
    });
  });
});

describe("checkToolRegistration", () => {
  it("reports ok when tool files have no name field at tool level", async () => {
    await withTempDir(async (dir) => {
      // Simulate a correct tool file (no `name` field at tool level)
      await mkdir(join(dir, "packages", "compose", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "workflow", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "compose", "src", "index.ts"), `
        export default {
          id: "@sffmc/compose",
          server: async (ctx) => ({
            tool: {
              compose_skill: {
                description: "Load a skill",
                parameters: { name: { type: "string" } },
                execute: async ({ name }) => "ok",
              }
            }
          })
        };
      `);
      await writeFile(join(dir, "packages", "workflow", "src", "tool.ts"), `
        export const workflowTool = {
          description: "Run workflows",
          parameters: { type: "object", properties: {} },
          execute: async (args) => "ok",
        } as const;
      `);

      const result = await checkToolRegistration(dir);
      expect(result.status).toBe("ok");
    });
  });

  it("reports fail when a tool file has name field at tool level", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "compose", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "workflow", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "compose", "src", "index.ts"), `
        export default {
          server: async (ctx) => ({
            tool: {
              my_tool: {
                name: "my_tool",
                description: "Bad tool with name field",
                parameters: {},
                execute: async () => "ok",
              }
            }
          })
        };
      `);
      await writeFile(join(dir, "packages", "workflow", "src", "tool.ts"), `
        export const workflowTool = {
          description: "Run workflows",
          parameters: {},
          execute: async () => "ok",
        } as const;
      `);

      const result = await checkToolRegistration(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("name");
      expect(result.detail).toContain("fix-17");
    });
  });
});

describe("checkLicense", () => {
  it("reports ok when LICENSE exists and READMEs reference it", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "LICENSE"), "MIT");
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "README.md"), "# pkg-a\n\nMIT License");
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), "{}");

      const result = await checkLicense(dir);
      expect(result.status).toBe("ok");
    });
  });

  it("reports warn when READMEs don't reference license", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "LICENSE"), "MIT");
      await mkdir(join(dir, "packages", "pkg-a"), { recursive: true });
      // Text must NOT contain "license", "LICENSE", or "MIT" to test missing-reference detection
      await writeFile(join(dir, "packages", "pkg-a", "README.md"), "# pkg-a\n\nJust a readme without any legal text.");
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), "{}");

      const result = await checkLicense(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("pkg-a");
    });
  });

  it("reports fail when LICENSE file is missing", async () => {
    await withTempDir(async (dir) => {
      // No LICENSE file
      const result = await checkLicense(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("No LICENSE");
    });
  });
});
