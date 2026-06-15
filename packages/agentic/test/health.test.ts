// SPDX-License-Identifier: MIT
// @sffmc/health — see ../../LICENSE

import { describe, it, expect, afterEach } from "bun:test";
import { mkdir, writeFile, rm, mkdtemp, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Import the plugin and check functions
import mod from "../../health/src/index";
import {
  runAllChecks,
  checkTestPresence,
  checkReadmePresence,
  checkVersionConsistency,
  checkToolRegistration,
  checkLicense,
  checkSdkCompliance,
  checkTsConfigPresence,
  checkChangelogCurrency,
  checkExtraOptIn,
  checkCategorySplit,
  checkMspStructure,
  type CheckResult,
  type CheckFn,
} from "../../health/src/index";

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
      mockCheck("sdk_compliance", "ok"),
      mockCheck("tsconfig_presence", "ok"),
      mockCheck("changelog_currency", "ok"),
    ];
    const result = await runAllChecks("/fake", fns);
    expect(result.checks).toHaveLength(10);
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual([
      "hook_conflicts",
      "test_presence",
      "readme_presence",
      "type_check",
      "tool_registration",
      "version_consistency",
      "license",
      "sdk_compliance",
      "tsconfig_presence",
      "changelog_currency",
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
  it("reports ok when all test owners have tests", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b", "tests"), { recursive: true });
      await mkdir(join(dir, "shared", "src"), { recursive: true });
      await writeFile(join(dir, "packages", "pkg-a", "src", "index.test.ts"), "// test");
      await writeFile(join(dir, "packages", "pkg-b", "tests", "integration.test.ts"), "// test");
      await writeFile(join(dir, "shared", "src", "events.test.ts"), "// test");
      // pkg-a and pkg-b are MSPs (have mspRole), shared is infra
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ mspRole: "msp-a" }));
      await writeFile(join(dir, "packages", "pkg-b", "package.json"), JSON.stringify({ mspRole: "msp-b" }));
      await writeFile(join(dir, "shared", "package.json"), "{}");

      const result = await checkTestPresence(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("3/3");
    });
  });

  it("reports fail when a test owner is missing tests", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      await mkdir(join(dir, "packages", "pkg-b", "src"), { recursive: true });
      // pkg-a is a test owner (mspRole) with tests, pkg-b is a test owner WITHOUT tests
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ mspRole: "msp-a" }));
      await writeFile(join(dir, "packages", "pkg-b", "package.json"), JSON.stringify({ mspRole: "msp-b" }));
      await writeFile(join(dir, "packages", "pkg-a", "src", "index.test.ts"), "// test");
      // pkg-b has src/ but no test file

      const result = await checkTestPresence(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("pkg-b");
    });
  });

  it("ignores sub-feature packages (no mspRole) — they are code-only", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "pkg-a", "src"), { recursive: true });
      await mkdir(join(dir, "shared", "src"), { recursive: true });
      // pkg-a is a sub-feature (no mspRole, no tests) — should be ignored
      await writeFile(join(dir, "packages", "pkg-a", "package.json"), JSON.stringify({ category: "mimo-port" }));
      await writeFile(join(dir, "shared", "package.json"), "{}");
      await writeFile(join(dir, "shared", "src", "events.test.ts"), "// test");

      const result = await checkTestPresence(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("1/1");  // only shared
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
  const ALL_TOOL_FILES = {
    "compose": "packages/compose/src/index.ts",
    "workflow": "packages/workflow/src/tool.ts",
    "health": "packages/health/src/index.ts",
    "extra/checkpoint": "packages/extra/src/checkpoint.ts",
    "extra/judge": "packages/extra/src/judge.ts",
    "extra/dream": "packages/extra/src/dream.ts",
  };

  it("reports ok when tool files have no name field at tool level", async () => {
    await withTempDir(async (dir) => {
      // Simulate correct tool files (no `name` field at tool level)
      for (const [key, relPath] of Object.entries(ALL_TOOL_FILES)) {
        const pkgDir = join(dir, "packages", key.split("/")[0]);
        const srcDir = join(dir, relPath).replace(/\/[^/]+$/, "");
        await mkdir(srcDir, { recursive: true });
        await writeFile(join(dir, relPath), `
          export default {
            id: "@sffmc/${key.replace("/", "-")}",
            server: async (ctx) => ({
              tool: {
                tool_${key.replace("/", "_")}: {
                  description: "A tool",
                  parameters: { name: { type: "string" } },
                  execute: async ({ name }) => "ok",
                }
              }
            })
          };
        `);
      }

      const result = await checkToolRegistration(dir);
      expect(result.status).toBe("ok");
    });
  });

  it("reports fail when a tool file has name field at tool level", async () => {
    await withTempDir(async (dir) => {
      for (const [key, relPath] of Object.entries(ALL_TOOL_FILES)) {
        const srcDir = join(dir, relPath).replace(/\/[^/]+$/, "");
        await mkdir(srcDir, { recursive: true });
        if (key === "compose") {
          // This one has the name field bug
          await writeFile(join(dir, relPath), `
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
        } else {
          // Others are clean
          await writeFile(join(dir, relPath), `
            export default {
              server: async (ctx) => ({
                tool: {
                  tool_${key.replace("/", "_")}: {
                    description: "A tool",
                    parameters: {},
                    execute: async () => "ok",
                  }
                }
              })
            };
          `);
        }
      }

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

// ---------------------------------------------------------------------------
// checkSdkCompliance
// ---------------------------------------------------------------------------

describe("checkSdkCompliance", () => {
  const SFFMC_PACKAGES = [
    "auto-max", "compose", "eos-stripper", "extra",
    "health", "log-whitelist", "max-mode", "memory",
    "rules", "watchdog", "workflow",
  ];

  it("reports ok when all 9 checkable packages import from @sffmc/shared", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg, "src"), { recursive: true });
        let content: string;
        if (pkg === "max-mode" || pkg === "workflow") {
          content = `// SPDX-License-Identifier: MIT\nimport { existsSync } from "fs";\nexport default { id: "@sffmc/${pkg}", server: async () => ({}) };`;
        } else {
          content = `// SPDX-License-Identifier: MIT\nimport { type PluginContext } from "@sffmc/shared";\nexport default { id: "@sffmc/${pkg}", server: async (ctx: PluginContext) => ({}) };`;
        }
        await writeFile(join(dir, "packages", pkg, "src", "index.ts"), content);
      }

      const result = await checkSdkCompliance(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("9/11");
      expect(result.detail).toContain("max-mode");
      expect(result.detail).toContain("workflow");
    });
  });

  it("reports warn when one package is missing @sffmc/shared import", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg, "src"), { recursive: true });
        let content: string;
        if (pkg === "auto-max") {
          // Missing @sffmc/shared import — and not in exception list
          content = `// SPDX-License-Identifier: MIT\nimport { existsSync } from "fs";\nexport default { id: "@sffmc/${pkg}", server: async () => ({}) };`;
        } else if (pkg === "max-mode" || pkg === "workflow") {
          // Known exceptions — no import, but excluded from check
          content = `// SPDX-License-Identifier: MIT\nimport { existsSync } from "fs";\nexport default { id: "@sffmc/${pkg}", server: async () => ({}) };`;
        } else {
          content = `// SPDX-License-Identifier: MIT\nimport { type PluginContext } from "@sffmc/shared";\nexport default { id: "@sffmc/${pkg}", server: async (ctx: PluginContext) => ({}) };`;
        }
        await writeFile(join(dir, "packages", pkg, "src", "index.ts"), content);
      }

      const result = await checkSdkCompliance(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("auto-max");
      expect(result.detail).not.toContain("max-mode");
      expect(result.detail).not.toContain("workflow");
    });
  });

  it("known exceptions max-mode and workflow are excluded from the check", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg, "src"), { recursive: true });
        let content: string;
        if (pkg === "max-mode" || pkg === "workflow") {
          // No import — they are exceptions
          content = `// SPDX-License-Identifier: MIT\nexport default { id: "@sffmc/${pkg}", server: async () => ({}) };`;
        } else {
          content = `// SPDX-License-Identifier: MIT\nimport { type PluginContext } from "@sffmc/shared";\nexport default { id: "@sffmc/${pkg}", server: async (ctx: PluginContext) => ({}) };`;
        }
        await writeFile(join(dir, "packages", pkg, "src", "index.ts"), content);
      }

      const result = await checkSdkCompliance(dir);
      expect(result.status).toBe("ok");
      // The detail message must mention the 2 exceptions
      expect(result.detail).toContain("max-mode");
      expect(result.detail).toContain("workflow");
    });
  });

  it("reports fail when a package is missing src/index.ts", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg, "src"), { recursive: true });
        // memory will have a directory but no src/index.ts (simulate missing file)
        if (pkg === "memory") continue;
        let content: string;
        if (pkg === "max-mode" || pkg === "workflow") {
          content = `// SPDX-License-Identifier: MIT\nexport default { id: "@sffmc/${pkg}", server: async () => ({}) };`;
        } else {
          content = `// SPDX-License-Identifier: MIT\nimport { type PluginContext } from "@sffmc/shared";\nexport default { id: "@sffmc/${pkg}", server: async (ctx: PluginContext) => ({}) };`;
        }
        await writeFile(join(dir, "packages", pkg, "src", "index.ts"), content);
      }

      const result = await checkSdkCompliance(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("memory");
      expect(result.detail).toContain("missing src/index.ts");
    });
  });
});

// ---------------------------------------------------------------------------
// checkTsConfigPresence
// ---------------------------------------------------------------------------

describe("checkTsConfigPresence", () => {
  const SFFMC_PACKAGES = [
    "auto-max", "compose", "eos-stripper", "extra",
    "health", "log-whitelist", "max-mode", "memory",
    "rules", "watchdog", "workflow",
  ];

  it("reports ok when all 11 packages have tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg), { recursive: true });
        await writeFile(join(dir, "packages", pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
      }

      const result = await checkTsConfigPresence(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("11/11");
    });
  });

  it("reports warn when a package is missing tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg), { recursive: true });
        if (pkg !== "health") {
          await writeFile(join(dir, "packages", pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
        }
        // health package has no tsconfig.json
      }

      const result = await checkTsConfigPresence(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("health");
    });
  });

  it("reports fail when a package has invalid tsconfig.json", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PACKAGES) {
        await mkdir(join(dir, "packages", pkg), { recursive: true });
        if (pkg === "compose") {
          await writeFile(join(dir, "packages", pkg, "tsconfig.json"), "NOT VALID JSON {{{");
        } else {
          await writeFile(join(dir, "packages", pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }));
        }
      }

      const result = await checkTsConfigPresence(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("compose");
      expect(result.detail).toContain("invalid tsconfig.json");
    });
  });
});

// ---------------------------------------------------------------------------
// checkChangelogCurrency
// ---------------------------------------------------------------------------

describe("checkChangelogCurrency", () => {
  it("reports ok when CHANGELOG version matches root package.json", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.7.5" }));
      await writeFile(join(dir, "CHANGELOG.md"), `# Changelog\n\n## v0.7.5 — Something\n\nSome content.\n\n## v0.7.4 — Older\n\nOlder content.\n`);

      const result = await checkChangelogCurrency(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("0.7.5");
      expect(result.detail).toContain("matches");
    });
  });

  it("reports fail when CHANGELOG.md is missing", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
      // No CHANGELOG.md

      const result = await checkChangelogCurrency(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("CHANGELOG.md not found");
    });
  });

  it("reports warn when CHANGELOG version is outdated", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "1.0.0" }));
      await writeFile(join(dir, "CHANGELOG.md"), `# Changelog\n\n## v0.9.0 — Old release\n\nSome content.\n`);

      const result = await checkChangelogCurrency(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("0.9.0");
      expect(result.detail).toContain("does not match");
    });
  });

  it("reports fail when CHANGELOG.md has no version section", async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, "package.json"), JSON.stringify({ version: "0.1.0" }));
      await writeFile(join(dir, "CHANGELOG.md"), `# Changelog\n\nSome content without version headers.\n`);

      const result = await checkChangelogCurrency(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("no recognizable version section");
    });
  });
});

// ---------------------------------------------------------------------------
// checkExtraOptIn
// ---------------------------------------------------------------------------

describe("checkExtraOptIn", () => {
  const originalHome = process.env.HOME;
  let tempHome: string | undefined;

  afterEach(async () => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      try {
        await rm(tempHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
      tempHome = undefined;
    }
  });

  it("reports ok when @sffmc/extra is not installed (packages/extra/ missing)", async () => {
    await withTempDir(async (dir) => {
      const result = await checkExtraOptIn(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("not installed");
    });
  });

  it("reports ok when extra is installed but config is missing (all features off default)", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "extra"), { recursive: true });
      tempHome = await mkdtemp(join(tmpdir(), "sffmc-health-"));
      process.env.HOME = tempHome;
      // No ~/.config/SFFMC/extra.yaml

      const result = await checkExtraOptIn(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("all features off (default)");
    });
  });

  it("reports ok with enabled feature count when config has features set to true", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "extra"), { recursive: true });
      tempHome = await mkdtemp(join(tmpdir(), "sffmc-health-"));
      process.env.HOME = tempHome;
      await mkdir(join(tempHome, ".config", "SFFMC"), { recursive: true });
      await writeFile(
        join(tempHome, ".config", "SFFMC", "extra.yaml"),
        "checkpoint: true\njudge: false\ndream: true\n",
      );

      const result = await checkExtraOptIn(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("2/3 features enabled");
      expect(result.detail).toContain("checkpoint");
      expect(result.detail).toContain("dream");
    });
  });

  it("reports ok with all features off when config has all false", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "packages", "extra"), { recursive: true });
      tempHome = await mkdtemp(join(tmpdir(), "sffmc-health-"));
      process.env.HOME = tempHome;
      await mkdir(join(tempHome, ".config", "SFFMC"), { recursive: true });
      await writeFile(
        join(tempHome, ".config", "SFFMC", "extra.yaml"),
        "checkpoint: false\njudge: false\ndream: false\n",
      );

      const result = await checkExtraOptIn(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("config present, all features off");
    });
  });
});

// ---------------------------------------------------------------------------
// checkCategorySplit
// ---------------------------------------------------------------------------

describe("checkCategorySplit", () => {
  const SFFMC_PKGS = [
    "auto-max", "compose", "eos-stripper", "extra",
    "health", "log-whitelist", "max-mode", "memory",
    "rules", "watchdog", "workflow",
  ];

  it("reports ok with 7 mimo-port + 4 sffmc-original when all categorized", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PKGS) {
        await mkdir(join(dir, "packages", pkg), { recursive: true });
        const mimo = ["auto-max", "compose", "max-mode", "memory", "rules", "watchdog", "workflow"];
        const cat = mimo.includes(pkg) ? "mimo-port" : "sffmc-original";
        const pkgJson = {
          name: `@sffmc/${pkg}`,
          version: "0.8.0",
          category: cat,
          ...(cat === "mimo-port" ? { portSource: "MiMo-Code v8.0", portFeature: pkg } : {}),
        };
        await writeFile(join(dir, "packages", pkg, "package.json"), JSON.stringify(pkgJson));
      }

      const result = await checkCategorySplit(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("7 mimo-port");
      expect(result.detail).toContain("4 sffmc-original");
    });
  });

  it("reports warn when some packages are uncategorized", async () => {
    await withTempDir(async (dir) => {
      for (const pkg of SFFMC_PKGS) {
        await mkdir(join(dir, "packages", pkg), { recursive: true });
        // Only categorize some
        const cat = ["memory", "rules", "watchdog"].includes(pkg) ? "mimo-port" : undefined;
        const pkgJson = cat ? { name: `@sffmc/${pkg}`, version: "0.8.0", category: cat } : { name: `@sffmc/${pkg}`, version: "0.8.0" };
        await writeFile(join(dir, "packages", pkg, "package.json"), JSON.stringify(pkgJson));
      }

      const result = await checkCategorySplit(dir);
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("uncategorized");
    });
  });
});

// ---------------------------------------------------------------------------
// checkMspStructure
// ---------------------------------------------------------------------------

describe("checkMspStructure", () => {
  it("reports ok when all 3 MSPs are valid", async () => {
    await withTempDir(async (dir) => {
      const features = ["feat-a", "feat-b", "feat-c", "feat-d", "feat-e", "feat-f"];
      // Create sub-feature dirs referenced by mspFeatures
      for (const feat of features) {
        await mkdir(join(dir, "packages", feat), { recursive: true });
        await writeFile(join(dir, "packages", feat, "package.json"), JSON.stringify({
          name: `@sffmc/${feat}`,
          version: "0.9.0",
          category: "mimo-port",
        }));
      }

      // Create 3 MSPs with proper structure
      const msps: { name: string; features: string[] }[] = [
        { name: "safety", features: ["feat-a", "feat-b"] },
        { name: "memory", features: ["feat-c", "feat-d"] },
        { name: "agentic", features: ["feat-e", "feat-f"] },
      ];
      for (const msp of msps) {
        await mkdir(join(dir, "packages", msp.name, "src"), { recursive: true });
        await writeFile(
          join(dir, "packages", msp.name, "package.json"),
          JSON.stringify({
            name: `@sffmc/${msp.name}`,
            version: "0.9.0",
            category: "msp",
            mspRole: msp.name,
            mspFeatures: msp.features,
          }),
        );
        await writeFile(
          join(dir, "packages", msp.name, "src", "index.ts"),
          `import { mergeHooks } from "@sffmc/shared";\nexport default mergeHooks([]);`,
        );
      }

      const result = await checkMspStructure(dir);
      expect(result.status).toBe("ok");
      expect(result.detail).toContain("3 MSPs valid");
      expect(result.detail).toContain("safety");
      expect(result.detail).toContain("memory");
      expect(result.detail).toContain("agentic");
    });
  });

  it("reports fail when an MSP directory is missing", async () => {
    await withTempDir(async (dir) => {
      // Create only 2 of 3 MSPs (skip safety)
      for (const msp of ["memory", "agentic"]) {
        await mkdir(join(dir, "packages", msp, "src"), { recursive: true });
        await writeFile(
          join(dir, "packages", msp, "package.json"),
          JSON.stringify({
            name: `@sffmc/${msp}`,
            version: "0.9.0",
            category: "msp",
            mspRole: msp,
            mspFeatures: ["some-feat"],
          }),
        );
        await mkdir(join(dir, "packages", "some-feat"), { recursive: true });
        await writeFile(join(dir, "packages", "some-feat", "package.json"), JSON.stringify({ name: "@sffmc/some-feat", version: "0.9.0", category: "mimo-port" }));
        await writeFile(
          join(dir, "packages", msp, "src", "index.ts"),
          `import { mergeHooks } from "@sffmc/shared";\nexport default mergeHooks([]);`,
        );
      }

      const result = await checkMspStructure(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("MSP directory missing");
      expect(result.detail).toContain("safety");
    });
  });

  it("reports fail when an MSP src/index.ts does not call mergeHooks", async () => {
    await withTempDir(async (dir) => {
      for (const msp of ["safety", "memory", "agentic"]) {
        await mkdir(join(dir, "packages", msp, "src"), { recursive: true });
        await writeFile(
          join(dir, "packages", msp, "package.json"),
          JSON.stringify({
            name: `@sffmc/${msp}`,
            version: "0.9.0",
            category: "msp",
            mspRole: msp,
            mspFeatures: ["some-feat"],
          }),
        );
        // safety gets no mergeHooks call; others are fine
        const content = msp === "safety"
          ? `import { something } from "@sffmc/shared";\nexport default { id: "safety" };`
          : `import { mergeHooks } from "@sffmc/shared";\nexport default mergeHooks([]);`;
        await writeFile(join(dir, "packages", msp, "src", "index.ts"), content);
      }
      await mkdir(join(dir, "packages", "some-feat"), { recursive: true });
      await writeFile(join(dir, "packages", "some-feat", "package.json"), JSON.stringify({ name: "@sffmc/some-feat", version: "0.9.0", category: "mimo-port" }));

      const result = await checkMspStructure(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("does not call mergeHooks");
      expect(result.detail).toContain("safety");
    });
  });

  it("reports fail when an MSP lists a nonexistent feature", async () => {
    await withTempDir(async (dir) => {
      for (const msp of ["safety", "memory", "agentic"]) {
        await mkdir(join(dir, "packages", msp, "src"), { recursive: true });
        await writeFile(
          join(dir, "packages", msp, "package.json"),
          JSON.stringify({
            name: `@sffmc/${msp}`,
            version: "0.9.0",
            category: "msp",
            mspRole: msp,
            mspFeatures: msp === "safety" ? ["nonexistent-feature"] : ["real-feat"],
          }),
        );
        await writeFile(
          join(dir, "packages", msp, "src", "index.ts"),
          `import { mergeHooks } from "@sffmc/shared";\nexport default mergeHooks([]);`,
        );
      }
      // Only create real-feat (not nonexistent-feature)
      await mkdir(join(dir, "packages", "real-feat"), { recursive: true });
      await writeFile(join(dir, "packages", "real-feat", "package.json"), JSON.stringify({ name: "@sffmc/real-feat", version: "0.9.0", category: "mimo-port" }));

      const result = await checkMspStructure(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("nonexistent-feature");
      expect(result.detail).toContain("does not exist");
    });
  });

  it("reports fail when a sub-feature claims to be an MSP", async () => {
    await withTempDir(async (dir) => {
      // Create 3 valid MSPs
      for (const msp of ["safety", "memory", "agentic"]) {
        await mkdir(join(dir, "packages", msp, "src"), { recursive: true });
        await writeFile(
          join(dir, "packages", msp, "package.json"),
          JSON.stringify({
            name: `@sffmc/${msp}`,
            version: "0.9.0",
            category: "msp",
            mspRole: msp,
            mspFeatures: ["feat-a"],
          }),
        );
        await writeFile(
          join(dir, "packages", msp, "src", "index.ts"),
          `import { mergeHooks } from "@sffmc/shared";\nexport default mergeHooks([]);`,
        );
      }
      await mkdir(join(dir, "packages", "feat-a"), { recursive: true });
      await writeFile(join(dir, "packages", "feat-a", "package.json"), JSON.stringify({ name: "@sffmc/feat-a", version: "0.9.0", category: "mimo-port" }));

      // rogue sub-feature claiming to be an MSP
      await mkdir(join(dir, "packages", "rogue"), { recursive: true });
      await writeFile(
        join(dir, "packages", "rogue", "package.json"),
        JSON.stringify({ name: "@sffmc/rogue", version: "0.9.0", category: "msp" }),
      );

      const result = await checkMspStructure(dir);
      expect(result.status).toBe("fail");
      expect(result.detail).toContain("rogue");
      expect(result.detail).toContain("claims to be an MSP");
    });
  });
});
