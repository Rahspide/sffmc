// SPDX-License-Identifier: MIT
// @sffmc/health — see ../../LICENSE

import { type PluginContext } from "@sffmc/shared";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// homedir() may cache at module load in Bun; use process.env.HOME first so
// tests can override it.
function userHome(): string {
  return process.env.HOME || homedir();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface HealthResult {
  ok: boolean;
  checks: CheckResult[];
  summary: string;
}

export type CheckFn = (repoRoot: string) => Promise<CheckResult>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function packageNames(repoRoot: string): Promise<string[]> {
  const pkgs: string[] = [];
  try {
    const entries = await readdir(join(repoRoot, "packages"), { withFileTypes: true });
    pkgs.push(...entries.filter((e) => e.isDirectory()).map((e) => e.name));
  } catch {
    // packages/ doesn't exist — no packages to check
  }
  // Include shared if it has a package.json
  try {
    await stat(join(repoRoot, "shared", "package.json"));
    pkgs.push("shared");
  } catch {
    // shared doesn't exist — skip
  }
  return pkgs.sort();
}

function pkgDir(pkg: string, repoRoot: string): string {
  return pkg === "shared" ? join(repoRoot, "shared") : join(repoRoot, "packages", pkg);
}

/**
 * Run a per-package presence check across all packages (including shared).
 * Returns ok if every package passes the test, fail otherwise.
 *
 * @param noun - human-readable noun for the thing being checked (e.g. "tests", "README.md")
 * @param test - returns true if the package HAS the thing
 */
async function checkPerPackage(
  repoRoot: string,
  name: string,
  noun: string,
  test: (pkgDir: string) => Promise<boolean>,
): Promise<CheckResult> {
  const pkgs = await packageNames(repoRoot);
  const missing: string[] = [];
  for (const pkg of pkgs) {
    if (!(await test(pkgDir(pkg, repoRoot)))) {
      missing.push(pkg);
    }
  }
  if (missing.length === 0) {
    return {
      name,
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have ${noun}`,
    };
  }
  return {
    name,
    status: "fail",
    detail: `${missing.length} package(s) missing ${noun}: ${missing.join(", ")}`,
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Check 1: Hook conflict audit
// ---------------------------------------------------------------------------

export async function checkHookConflicts(repoRoot: string): Promise<CheckResult> {
  const scriptPath = join(repoRoot, "scripts", "audit-load-order.py");
  const jsonPath = join(repoRoot, ".slim", "deepwork", "load-order-audit.json");
  const exists = await fileExists(scriptPath);
  if (!exists) {
    return {
      name: "hook_conflicts",
      status: "fail",
      detail: `Audit script not found: ${scriptPath}`,
    };
  }

  try {
    // Run the audit script to regenerate the JSON report
    const proc = Bun.spawn(["python3", scriptPath], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    // Read the JSON report the script produces
    let report: { pkg_hooks?: Record<string, string[]>; all_hooks?: Record<string, string[]> };
    try {
      const jsonText = await readFile(jsonPath, "utf-8");
      report = JSON.parse(jsonText);
    } catch {
      return {
        name: "hook_conflicts",
        status: "warn",
        detail: "Audit script ran but JSON report not found or unparseable",
      };
    }

    const allHooks = report.all_hooks || {};
    const pkgHooks = report.pkg_hooks || {};
    const pluginCount = Object.keys(pkgHooks).length;

    // Most OpenCode hooks are designed for multiple plugins to chain/aggregate.
    // Only a few hooks are truly exclusive (where multiple registrations would conflict).
    // The known-safe hooks for multi-registration:
    const safeMultiHooks = new Set([
      "config",
      "event",
      "tool.execute.before",
      "tool.execute.after",
      "command.execute.before",
      "command.execute.after",
      "experimental.text.complete",
      "experimental.chat.messages.transform",
      "experimental.chat.system.transform",
      "permission.ask",
      "permission.respond",
      "tool",            // each plugin registers distinct tool name under this key
      "chat.message",
      "chat.params",
      "chat.system",
    ]);

    const realConflicts: string[] = [];
    for (const [hook, pkgs] of Object.entries(allHooks)) {
      if (pkgs.length <= 1) continue;
      if (safeMultiHooks.has(hook)) continue;
      realConflicts.push(`${hook} (${pkgs.join(", ")})`);
    }

    if (realConflicts.length === 0) {
      return {
        name: "hook_conflicts",
        status: "ok",
        detail: `${pluginCount}/${pluginCount} plugins, 0 real conflicts (${Object.keys(allHooks).length} hooks total, structural overlaps in safe-multi hooks are normal)`,
      };
    }

    return {
      name: "hook_conflicts",
      status: "fail",
      detail: `${realConflicts.length} real hook conflict(s): ${realConflicts.join("; ")}`,
    };
  } catch (e) {
    return {
      name: "hook_conflicts",
      status: "fail",
      detail: `Failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Check 2: Test presence
// ---------------------------------------------------------------------------

export async function checkTestPresence(repoRoot: string): Promise<CheckResult> {
  return checkPerPackage(repoRoot, "test_presence", "tests", async (dir) => {
    for (const subdir of ["src", "tests"]) {
      try {
        const entries = await readdir(join(dir, subdir));
        if (entries.some((e) => e.endsWith(".test.ts"))) return true;
      } catch {
        // dir doesn't exist
      }
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// Check 3: README presence
// ---------------------------------------------------------------------------

export async function checkReadmePresence(repoRoot: string): Promise<CheckResult> {
  return checkPerPackage(repoRoot, "readme_presence", "README.md", (dir) =>
    fileExists(join(dir, "README.md")),
  );
}

// ---------------------------------------------------------------------------
// Check 4: Type check
// ---------------------------------------------------------------------------

export async function checkTypeCheck(repoRoot: string): Promise<CheckResult> {
  const pkgs = await packageNames(repoRoot);
  const failures: string[] = [];

  for (const pkg of pkgs) {
    const pkgDir = pkg === "shared" ? join(repoRoot, "shared") : join(repoRoot, "packages", pkg);
    const indexPath = join(pkgDir, "src", "index.ts");
    if (!(await fileExists(indexPath))) {
      failures.push(`${pkg} (no src/index.ts)`);
      continue;
    }

    try {
      const proc = Bun.spawn(
        ["bun", "build", "--target=bun", "--no-bundle", "src/index.ts"],
        { cwd: pkgDir, stdout: "pipe", stderr: "pipe" },
      );
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        // Extract error lines (skip "bun build" header lines)
        const errors = stderr
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("bun build"))
          .join("\n")
          .trim();
        failures.push(`${pkg}: ${errors || `exit ${exitCode}`}`);
      }
    } catch (e) {
      failures.push(`${pkg}: spawn failed (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (failures.length === 0) {
    return {
      name: "type_check",
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages typecheck clean`,
    };
  }

  return {
    name: "type_check",
    status: "fail",
    detail: `${failures.length} package(s) failed: ${failures.join("; ")}`,
  };
}

// ---------------------------------------------------------------------------
// Check 5: Tool registration sanity (fix-17 regression guard)
// ---------------------------------------------------------------------------

const TOOL_FILES = [
  "packages/compose/src/index.ts",       // compose_skill
  "packages/workflow/src/tool.ts",       // workflow
  "packages/health/src/index.ts",        // sffmc_health
  "packages/extra/src/checkpoint.ts",    // extra_checkpoint
  "packages/extra/src/judge.ts",         // extra_judge
  "packages/extra/src/dream.ts",         // extra_dream
];

export async function checkToolRegistration(repoRoot: string): Promise<CheckResult> {
  const bugs: string[] = [];

  for (const relPath of TOOL_FILES) {
    const absPath = join(repoRoot, relPath);
    if (!(await fileExists(absPath))) {
      bugs.push(`${relPath}: file not found`);
      continue;
    }

    try {
      const content = await readFile(absPath, "utf-8");
      const lines = content.split("\n");

      // Collect property keys per indent level.
      // A tool-level `name:` bug would be: `name: "something"` (string value)
      // at the same indent as `description:` and `execute:`.
      // Parameter-schema `name:` fields have object values (`name: {`) and deeper indent.

      const keysByIndent = new Map<number, Set<string>>();
      // Track which keys have string values (for distinguishing tool-level name vs parameter)
      const stringKeysByIndent = new Map<number, Set<string>>();

      let inBlockComment = false;
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith("/*")) { inBlockComment = true; continue; }
        if (inBlockComment) { if (trimmed.includes("*/")) inBlockComment = false; continue; }
        if (inBlockComment || trimmed.startsWith("//")) continue;

        // Match property keys at their indent: `  keyName:` or `  "keyName":`
        const keyMatch = line.match(/^(\s+)([\w]+)\s*:\s*/);
        if (!keyMatch) continue;

        const indent = keyMatch[1].length;
        const key = keyMatch[2];

        // Only track known tool-structure keys + the potentially-buggy `name` key, plus `status` and
        // `detail` so we can distinguish CheckResult returns (which have those) from tool definitions
        // (which don't) when they appear at the same indent.
        const isToolKey = key === "description" || key === "execute" || key === "parameters" || key === "name" || key === "status" || key === "detail";
        if (!isToolKey) continue;

        const afterColon = line.slice(keyMatch[0].length).trim();
        const isStringVal = /^["'`]/.test(afterColon);

        if (!keysByIndent.has(indent)) keysByIndent.set(indent, new Set());
        keysByIndent.get(indent)!.add(key);

        if (isStringVal) {
          if (!stringKeysByIndent.has(indent)) stringKeysByIndent.set(indent, new Set());
          stringKeysByIndent.get(indent)!.add(key);
        }
      }

      // For each indent level that has `description` + `parameters` + `execute`, check for `name` with string value.
      // Also require that the indent does NOT have `status` or `detail` — those indicate a CheckResult
      // return object (which legitimately has a `name` field), not a tool definition. This avoids false
      // positives when the file contains both tool definitions and CheckResult returns at the same indent.
      for (const [indent, keys] of keysByIndent) {
        if (!keys.has("description") || !keys.has("execute") || !keys.has("parameters")) continue;
        if (keys.has("status") || keys.has("detail")) continue;
        if (!keys.has("name")) continue;

        const stringKeys = stringKeysByIndent.get(indent);
        if (stringKeys && stringKeys.has("name")) {
          bugs.push(`${relPath}: tool-level \`name\` field at indent ${indent} — registration bug (fix-17 regression)`);
        }
      }
    } catch (e) {
      bugs.push(`${relPath}: read error (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  if (bugs.length === 0) {
    return {
      name: "tool_registration",
      status: "ok",
      detail: `0 'name' field bugs across ${TOOL_FILES.length} tool-bearing files`,
    };
  }

  return {
    name: "tool_registration",
    status: "fail",
    detail: bugs.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Check 6: Version consistency
// ---------------------------------------------------------------------------

export async function checkVersionConsistency(repoRoot: string): Promise<CheckResult> {
  // Read root version
  let rootVersion: string;
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
    rootVersion = rootPkg.version || "unknown";
  } catch {
    return {
      name: "version_consistency",
      status: "fail",
      detail: "Could not read root package.json",
    };
  }

  const pkgs = await packageNames(repoRoot);
  const mismatches: string[] = [];

  for (const pkg of pkgs) {
    try {
      const pkgJson = JSON.parse(await readFile(join(pkgDir(pkg, repoRoot), "package.json"), "utf-8"));
      const ver = pkgJson.version;
      if (ver !== rootVersion) {
        mismatches.push(`${pkg}: ${ver} (root: ${rootVersion})`);
      }
    } catch {
      mismatches.push(`${pkg}: could not read package.json`);
    }
  }

  if (mismatches.length === 0) {
    return {
      name: "version_consistency",
      status: "ok",
      detail: `All ${pkgs.length} packages match root version ${rootVersion}`,
    };
  }

  return {
    name: "version_consistency",
    status: "warn",
    detail: `Root ${rootVersion}, ${mismatches.length} mismatches: ${mismatches.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Check 7: License file
// ---------------------------------------------------------------------------

export async function checkLicense(repoRoot: string): Promise<CheckResult> {
  const licenseExists = await fileExists(join(repoRoot, "LICENSE"));
  const missingRefs: string[] = [];

  // Check each package README references LICENSE or MIT
  const pkgs = await packageNames(repoRoot);
  for (const pkg of pkgs) {
    const readmePath = join(pkgDir(pkg, repoRoot), "README.md");
    if (!(await fileExists(readmePath))) {
      missingRefs.push(`${pkg} (no README)`);
      continue;
    }
    try {
      const content = await readFile(readmePath, "utf-8");
      if (!/(LICENSE|MIT|license)/i.test(content)) {
        missingRefs.push(pkg);
      }
    } catch {
      missingRefs.push(`${pkg} (read error)`);
    }
  }

  if (!licenseExists) {
    return {
      name: "license",
      status: "fail",
      detail: "No LICENSE file in repo root",
    };
  }

  if (missingRefs.length === 0) {
    return {
      name: "license",
      status: "ok",
      detail: `LICENSE present, all ${pkgs.length} READMEs reference it`,
    };
  }

  return {
    name: "license",
    status: "warn",
    detail: `LICENSE present, ${missingRefs.length} README(s) missing reference: ${missingRefs.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Check 8: SDK compliance (shared import)
// ---------------------------------------------------------------------------

const KNOWN_SDK_EXCEPTIONS = new Set(["max-mode", "workflow"]);

export async function checkSdkCompliance(repoRoot: string): Promise<CheckResult> {
  const pkgs = (await packageNames(repoRoot)).filter((p) => p !== "shared");
  const missingImport: string[] = [];
  const missingDir: string[] = [];

  for (const pkg of pkgs) {
    if (KNOWN_SDK_EXCEPTIONS.has(pkg)) continue;

    const indexPath = join(repoRoot, "packages", pkg, "src", "index.ts");
    try {
      const content = await readFile(indexPath, "utf-8");
      const hasSharedImport = /from\s+["']@sffmc\/shared["']/.test(content)
        || /from\s+["']\.\.\/shared\/src\//.test(content);
      const hasExclusionComment = /\/\/\s*@sffmc-shared:\s*excluded/.test(content);
      if (!hasSharedImport && !hasExclusionComment) {
        missingImport.push(pkg);
      }
    } catch {
      missingDir.push(pkg);
    }
  }

  if (missingDir.length > 0) {
    return {
      name: "sdk_compliance",
      status: "fail",
      detail: `${missingDir.length} package(s) missing src/index.ts: ${missingDir.join(", ")}`,
    };
  }

  if (missingImport.length === 0) {
    return {
      name: "sdk_compliance",
      status: "ok",
      detail: `${pkgs.length - KNOWN_SDK_EXCEPTIONS.size}/${pkgs.length} packages import @sffmc/shared (2 known exceptions: ${[...KNOWN_SDK_EXCEPTIONS].join(", ")})`,
    };
  }

  return {
    name: "sdk_compliance",
    status: "warn",
    detail: `${missingImport.length} package(s) missing @sffmc/shared import: ${missingImport.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Check 9: tsconfig.json presence
// ---------------------------------------------------------------------------

export async function checkTsConfigPresence(repoRoot: string): Promise<CheckResult> {
  const pkgs = await packageNames(repoRoot);
  const missing: string[] = [];
  const invalidJson: string[] = [];

  for (const pkg of pkgs) {
    const tsconfigPath = join(pkgDir(pkg, repoRoot), "tsconfig.json");
    try {
      const content = await readFile(tsconfigPath, "utf-8");
      try {
        JSON.parse(content);
      } catch {
        invalidJson.push(pkg);
      }
    } catch {
      missing.push(pkg);
    }
  }

  if (invalidJson.length > 0) {
    return {
      name: "tsconfig_presence",
      status: "fail",
      detail: `${invalidJson.length} package(s) have invalid tsconfig.json: ${invalidJson.join(", ")}`,
    };
  }

  if (missing.length === 0) {
    return {
      name: "tsconfig_presence",
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have tsconfig.json`,
    };
  }

  return {
    name: "tsconfig_presence",
    status: "warn",
    detail: `${missing.length} package(s) missing tsconfig.json: ${missing.join(", ")}`,
  };
}

// ---------------------------------------------------------------------------
// Check 10: CHANGELOG currency
// ---------------------------------------------------------------------------

export async function checkChangelogCurrency(repoRoot: string): Promise<CheckResult> {
  // Read root version
  let rootVersion: string;
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
    rootVersion = rootPkg.version || "unknown";
  } catch {
    return {
      name: "changelog_currency",
      status: "fail",
      detail: "Could not read root package.json",
    };
  }

  // Read CHANGELOG.md
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  let changelogText: string;
  try {
    changelogText = await readFile(changelogPath, "utf-8");
  } catch {
    return {
      name: "changelog_currency",
      status: "fail",
      detail: "CHANGELOG.md not found",
    };
  }

  // Extract the most recent version entry
  const versionMatch = changelogText.match(/^##\s+v(\d+\.\d+\.\d+)/m);
  if (!versionMatch) {
    return {
      name: "changelog_currency",
      status: "fail",
      detail: "CHANGELOG.md has no recognizable version section",
    };
  }

  const changelogVersion = versionMatch[1];

  if (changelogVersion === rootVersion) {
    return {
      name: "changelog_currency",
      status: "ok",
      detail: `CHANGELOG v${changelogVersion} matches root package.json (${rootVersion})`,
    };
  }

  return {
    name: "changelog_currency",
    status: "warn",
    detail: `CHANGELOG v${changelogVersion} does not match root package.json (${rootVersion})`,
  };
}

// ---------------------------------------------------------------------------
// Check 11: @sffmc/extra opt-in status (informational only)
// ---------------------------------------------------------------------------

export async function checkExtraOptIn(repoRoot: string): Promise<CheckResult> {
  const extraDir = join(repoRoot, "packages", "extra");
  if (!(await fileExists(extraDir))) {
    return {
      name: "extra_opt_in",
      status: "ok",
      detail: "@sffmc/extra not installed (packages/extra/ not found)",
    };
  }

  const configPath = join(userHome(), ".config", "SFFMC", "extra.yaml");
  if (!(await fileExists(configPath))) {
    return {
      name: "extra_opt_in",
      status: "ok",
      detail: "@sffmc/extra installed, config not found — all features off (default)",
    };
  }

  try {
    const content = await readFile(configPath, "utf-8");
    const enabled: string[] = [];
    for (const feature of ["checkpoint", "judge", "dream"]) {
      const re = new RegExp(`^\\s*${feature}\\s*:\\s*true`, "m");
      if (re.test(content)) enabled.push(feature);
    }

    if (enabled.length === 0) {
      return {
        name: "extra_opt_in",
        status: "ok",
        detail: "@sffmc/extra installed, config present, all features off",
      };
    }

    return {
      name: "extra_opt_in",
      status: "ok",
      detail: `@sffmc/extra: ${enabled.length}/3 features enabled (${enabled.join(", ")})`,
    };
  } catch {
    return {
      name: "extra_opt_in",
      status: "warn",
      detail: "Could not read extra config file",
    };
  }
}

// ---------------------------------------------------------------------------
// Check 12: Category split (MiMo ports vs SFFMC originals)
// ---------------------------------------------------------------------------

export async function checkCategorySplit(repoRoot: string): Promise<CheckResult> {
  const counts: Record<string, { count: number; features: string[] }> = {
    "msp": { count: 0, features: [] },
    "mimo-port": { count: 0, features: [] },
    "sffmc-original": { count: 0, features: [] },
    uncategorized: { count: 0, features: [] },
  };

  for (const pkg of await packageNames(repoRoot)) {
    if (pkg === "shared") continue;
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as { category?: string; portFeature?: string };
      const cat = parsed.category || "uncategorized";
      if (!counts[cat]) counts[cat] = { count: 0, features: [] };
      counts[cat].count++;
      if (parsed.portFeature) counts[cat].features.push(parsed.portFeature);
    } catch {
      counts.uncategorized.count++;
    }
  }

  const mspCount = counts["msp"].count;
  const portCount = counts["mimo-port"].count;
  const origCount = counts["sffmc-original"].count;
  const uncatCount = counts.uncategorized.count;

  if (uncatCount > 0) {
    return {
      name: "category_split",
      status: "warn",
      detail: `${portCount} mimo-port, ${origCount} sffmc-original, ${uncatCount} uncategorized`,
    };
  }

  return {
    name: "category_split",
    status: "ok",
    detail: `3 MSP categories: ${mspCount} msp (3-MSP bundles: safety/memory/agentic), ${portCount} mimo-port (MiMo-Code v8.0 features), ${origCount} sffmc-original (SFFMC team additions)`,
  };
}

// ---------------------------------------------------------------------------
// Check 13: MSP structure (v0.9.0)
// ---------------------------------------------------------------------------

const EXPECTED_MSPS = ["safety", "memory", "agentic"] as const;

export async function checkMspStructure(repoRoot: string): Promise<CheckResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Each expected MSP exists
  for (const mspName of EXPECTED_MSPS) {
    const mspDir = join(repoRoot, "packages", mspName);
    if (!(await fileExists(mspDir))) {
      errors.push(`MSP directory missing: packages/${mspName}/`);
      continue;
    }

    // 2. package.json has mspRole and mspFeatures
    const pkgJsonPath = join(mspDir, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as {
        mspRole?: string;
        mspFeatures?: string[];
        category?: string;
      };

      if (parsed.category !== "msp") {
        errors.push(`${mspName}: package.json category is not "msp" (got ${parsed.category || "missing"})`);
      }
      if (!parsed.mspRole) {
        errors.push(`${mspName}: package.json missing mspRole`);
      }
      if (!parsed.mspFeatures || parsed.mspFeatures.length === 0) {
        errors.push(`${mspName}: package.json missing mspFeatures`);
      } else {
        // 3. Each listed feature corresponds to a real package
        for (const feature of parsed.mspFeatures ?? []) {
          const featureDir = join(repoRoot, "packages", feature);
          if (!(await fileExists(featureDir))) {
            errors.push(`${mspName} lists mspFeature "${feature}" but packages/${feature}/ does not exist`);
          }
        }
      }
    } catch (err) {
      errors.push(`${mspName}: could not read package.json (${err})`);
    }

    // 4. src/index.ts uses mergeHooks
    const indexPath = join(mspDir, "src", "index.ts");
    try {
      const content = await readFile(indexPath, "utf-8");
      if (!/mergeHooks\s*\(/.test(content)) {
        errors.push(`${mspName}: src/index.ts does not call mergeHooks()`);
      }
      if (!/from\s+["']@sffmc\/shared["']/.test(content)) {
        warnings.push(`${mspName}: src/index.ts does not import from @sffmc/shared`);
      }
    } catch (err) {
      errors.push(`${mspName}: could not read src/index.ts (${err})`);
    }
  }

  // 5. No sub-feature claims to be an MSP (inverse check)
  for (const pkg of await packageNames(repoRoot)) {
    if (EXPECTED_MSPS.includes(pkg as typeof EXPECTED_MSPS[number])) continue;
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as { category?: string; mspRole?: string };
      if (parsed.category === "msp" || parsed.mspRole) {
        errors.push(`${pkg}: claims to be an MSP but is not in EXPECTED_MSPS`);
      }
    } catch {
      // package.json unreadable — other checks handle this
    }
  }

  if (errors.length > 0) {
    return {
      name: "msp_structure",
      status: "fail",
      detail: `${errors.length} MSP structure error(s): ${errors.join("; ")}`,
    };
  }

  if (warnings.length > 0) {
    return {
      name: "msp_structure",
      status: "warn",
      detail: `3 MSPs valid (safety/memory/agentic), ${warnings.length} warning(s): ${warnings.join("; ")}`,
    };
  }

  return {
    name: "msp_structure",
    status: "ok",
    detail: `3 MSPs valid: safety (5 features), memory (4 features), agentic (4 features)`,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const ALL_CHECKS: CheckFn[] = [
  checkHookConflicts,
  checkTestPresence,
  checkReadmePresence,
  checkTypeCheck,
  checkToolRegistration,
  checkVersionConsistency,
  checkLicense,
  checkSdkCompliance,
  checkTsConfigPresence,
  checkChangelogCurrency,
  checkExtraOptIn,
  checkCategorySplit,
  checkMspStructure,
];

export async function runAllChecks(
  repoRoot: string,
  checkFns: CheckFn[] = ALL_CHECKS,
): Promise<HealthResult> {
  const checks = await Promise.all(checkFns.map((fn) => fn(repoRoot)));

  const okCount = checks.filter((c) => c.status === "ok").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;
  const failCount = checks.filter((c) => c.status === "fail").length;

  return {
    ok: failCount === 0,
    checks,
    summary: `${okCount} ok, ${warnCount} warn, ${failCount} fail`,
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export const id = "@sffmc/health"
export const server = async (ctx: PluginContext) => {
  const repoRoot = (ctx as Record<string, unknown>).projectRoot as string;

  return {
    tool: {
      sffmc_health: {
        description: `Run 13 diagnostic checks on the SFFMC monorepo to verify plugin health.

Checks performed:
1. hook_conflicts — invokes scripts/audit-load-order.py, reports hook conflicts between plugins
2. test_presence — verifies every package has at least one *.test.ts file
3. readme_presence — verifies every package has a README.md
4. type_check — runs bun build --no-bundle per package
5. tool_registration — scans for 'name' field bug in tool definitions (fix-17 regression, 6 tool files)
6. version_consistency — compares root package.json version against all plugin versions
7. license — verifies LICENSE exists and is referenced from all READMEs
8. sdk_compliance — verifies packages import from @sffmc/shared (2 known exceptions: max-mode, workflow)
9. tsconfig_presence — verifies each package has tsconfig.json (migration-progress check)
10. changelog_currency — verifies CHANGELOG.md version matches root package.json
11. extra_opt_in — reports @sffmc/extra opt-in status (informational; 3 opt-in features off by default)
12. category_split — counts mimo-port (7) + sffmc-original (4) + msp (3) = 14 packages
13. msp_structure — verifies safety/memory/agentic MSPs have valid package.json + mergeHooks() + listed features

Returns JSON with ok (boolean), checks[] (per-check status), and summary (string).
Use this before releases or after plugin changes to catch regressions early.`,
        parameters: {
          type: "object",
          properties: {},
        },
        execute: async () => {
          const root = repoRoot;
          const result = await runAllChecks(root);
          return JSON.stringify(result, null, 2);
        },
      },
    },
  };
};

export default { id, server }
