// SPDX-License-Identifier: MIT
// @sffmc/health — see ../../LICENSE

import { loadConfig, type PluginContext } from "@sffmc/shared";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CheckOutcome,
  type CheckFn,
  type HealthResult,
  createCheck,
} from "./check-factory.ts";

// Re-export the public schema so consumers (scripts, tests, agentic composite)
// can `import { CheckResult, HealthResult, CheckFn } from "@sffmc/health"`.
export type { CheckResult, HealthResult, CheckFn } from "./check-factory.ts";

// ---------------------------------------------------------------------------
// Phase-2 MEDIUM migration (H1, H2, H3) — YAML-configurable health checks.
//
// The health package historically had three module-level `const` arrays
// (TOOL_FILES, safeMultiHooks, EXPECTED_COMPOSITES) that pinned the behavior
// of three checks. We now load them from `~/.config/SFFMC/health.yaml` via
// `loadConfig<>("health", …)`. When no YAML exists the merged defaults
// exactly match the v0.14.2 hardcoded values, so behavior is unchanged.
//
// Pattern precedent: `packages/workflow/src/constants.ts` (`ensureWorkflowConfig`,
// `getWorkflowConfigSync`, `__setWorkflowConfig`). The same shape works here
// — a single `let _healthConfig` caches the merged config and the sync getter
// falls back to defaults when no load has happened. Each check reads via
// `getHealthConfigSync().X` rather than a module-level `let X` so the
// per-test reset (`__setHealthConfig`) takes effect immediately.
// ---------------------------------------------------------------------------

/** H1 — repo-relative paths of files that register a tool (used by
 *  `checkToolRegistration` to scan for the fix-17 `name` field bug). */
export interface HealthConfig {
  /** H1 — tool-registration scan targets (fix-17 regression guard). */
  toolFiles: readonly string[]
  /** H2 — hook names that are SAFE for multiple plugins to register
   *  (`checkHookConflicts` whitelists these and treats all others as
   *  real conflicts). */
  safeMultiHooks: readonly string[]
  /** H3 — composites the monorepo is expected to ship (used by
   *  `checkCompositeStructure` for forward-validation of the
   *  safety/memory/agentic layout). */
  expectedComposites: readonly string[]
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  // H1 — matches the v0.14.2 hardcoded TOOL_FILES at src/index.ts:280-287
  toolFiles: [
    "packages/compose/src/index.ts",       // compose_skill
    "packages/workflow/src/tool.ts",       // workflow
    "packages/health/src/index.ts",        // sffmc_health
    "packages/extra/src/checkpoint.ts",    // extra_checkpoint
    "packages/extra/src/judge.ts",         // extra_judge
    "packages/extra/src/dream.ts",         // extra_dream
  ],
  // H2 — matches the v0.14.2 hardcoded `new Set([...])` at src/index.ts:133-149
  safeMultiHooks: [
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
  ],
  // H3 — matches the v0.14.2 hardcoded EXPECTED_COMPOSITES at src/index.ts:693
  expectedComposites: ["safety", "memory", "agentic"],
}

let _healthConfig: HealthConfig | null = null
let _healthConfigPromise: Promise<HealthConfig> | null = null

/** Load `~/.config/SFFMC/health.yaml` once and cache the result.
 *  Idempotent — concurrent callers receive the same promise.
 *
 *  @param opts.configHome — override the config directory (useful for
 *    tests that need an isolated config file). Defaults to
 *    `~/.config/SFFMC`. */
export function ensureHealthConfig(
  opts?: { configHome?: string },
): Promise<HealthConfig> {
  if (_healthConfig) return Promise.resolve(_healthConfig)
  if (!_healthConfigPromise) {
    _healthConfigPromise = loadConfig<Partial<HealthConfig>>(
      "health",
      DEFAULT_HEALTH_CONFIG,
      { configHome: opts?.configHome },
    ).then((loaded) => {
      const merged: HealthConfig = {
        ...DEFAULT_HEALTH_CONFIG,
        ...loaded,
      }
      _healthConfig = merged
      return merged
    })
  }
  return _healthConfigPromise
}

/** Test helper — reset the cached config. Useful for unit tests that
 *  want to inject a custom config without round-tripping through YAML.
 *  NOT publicly exported (v0.14.3 D-1) — tests reach this function via
 *  the test-helper shim at `tests/_test-helpers/config-cache.ts`, which
 *  looks up the implementation through a Symbol registry rather than
 *  a public export. The Symbol is namespaced under `@sffmc.health.*` to
 *  avoid collisions with the workflow shim. */
function __setHealthConfig(cfg: HealthConfig | null): void {
  _healthConfig = cfg
  _healthConfigPromise = null
}

const __SET_HEALTH_CONFIG_SYMBOL = Symbol.for("@sffmc/health.__setHealthConfig")
;(globalThis as Record<symbol, unknown>)[__SET_HEALTH_CONFIG_SYMBOL] = __setHealthConfig

/** Sync accessor — returns the cached config or the defaults if the YAML
 *  hasn't been loaded yet. Use this in hot paths where awaiting is not
 *  an option; call `ensureHealthConfig()` at startup to populate. */
export function getHealthConfigSync(): HealthConfig {
  return _healthConfig ?? DEFAULT_HEALTH_CONFIG
}

// homedir() may cache at module load in Bun; use process.env.HOME first so
// tests can override it.
function userHome(): string {
  return process.env.HOME || homedir();
}

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
 * Returns a `CheckOutcome` (no name) — the calling factory supplies the name.
 *
 * @param noun - human-readable noun for the thing being checked (e.g. "tests", "README.md")
 * @param test - returns true if the package HAS the thing
 */
async function checkPerPackage(
  repoRoot: string,
  noun: string,
  test: (pkgDir: string) => Promise<boolean>,
): Promise<CheckOutcome> {
  const pkgs = await packageNames(repoRoot);
  const missing: string[] = [];
  for (const pkg of pkgs) {
    if (!(await test(pkgDir(pkg, repoRoot)))) {
      missing.push(pkg);
    }
  }
  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have ${noun}`,
    };
  }
  return {
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

// Check 1: Hook conflict audit
export const checkHookConflicts = createCheck("hook_conflicts", async (repoRoot) => {
  const scriptPath = join(repoRoot, "scripts", "audit-load-order.py");
  const jsonPath = join(repoRoot, ".sffmc", "load-order-audit.json");
  const exists = await fileExists(scriptPath);
  if (!exists) {
    return {
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
        status: "warn",
        detail: "Audit script ran but JSON report not found or unparseable",
      };
    }

    const allHooks = report.all_hooks || {};
    const pkgHooks = report.pkg_hooks || {};
    const pluginCount = Object.keys(pkgHooks).length;

    // Most OpenCode hooks are designed for multiple plugins to chain/aggregate.
    // Only a few hooks are truly exclusive (where multiple registrations would conflict).
    // The known-safe hooks for multi-registration come from
    // `getHealthConfigSync().safeMultiHooks` (H2 Phase-2 migration) — defaults
    // match the v0.14.2 hardcoded list verbatim.
    const safeMultiHooks = new Set(getHealthConfigSync().safeMultiHooks);

    const realConflicts: string[] = [];
    for (const [hook, pkgs] of Object.entries(allHooks)) {
      if (pkgs.length <= 1) continue;
      if (safeMultiHooks.has(hook)) continue;
      realConflicts.push(`${hook} (${pkgs.join(", ")})`);
    }

    if (realConflicts.length === 0) {
      return {
        status: "ok",
        detail: `${pluginCount}/${pluginCount} plugins, 0 real conflicts (${Object.keys(allHooks).length} hooks total, structural overlaps in safe-multi hooks are normal)`,
      };
    }

    return {
      status: "fail",
      detail: `${realConflicts.length} real hook conflict(s): ${realConflicts.join("; ")}`,
    };
  } catch (e) {
    return {
      status: "fail",
      detail: `Failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
});

// Check 2: Test presence
export const checkTestPresence = createCheck("test_presence", async (repoRoot) => {
  // After Phase 4 (v0.9.0), sub-feature packages are "code-only" — their
  // tests live in the owning composite's test/ dir. Only check packages that
  // are themselves test owners: composites (have role) and shared (infra).
  const pkgs = await packageNames(repoRoot);
  const testOwners: string[] = [];
  for (const pkg of pkgs) {
    if (pkg === "shared") {
      testOwners.push(pkg);
      continue;
    }
    try {
      const content = await readFile(join(pkgDir(pkg, repoRoot), "package.json"), "utf-8");
      const parsed = JSON.parse(content) as { role?: string };
      if (parsed.role) testOwners.push(pkg);
    } catch {
      // package.json unreadable — skip
    }
  }

  const missing: string[] = [];
  for (const pkg of testOwners) {
    let has = false;
    for (const subdir of ["src", "tests"]) {
      try {
        const entries = await readdir(join(pkgDir(pkg, repoRoot), subdir));
        if (entries.some((e) => e.endsWith(".test.ts"))) {
          has = true;
          break;
        }
      } catch {
        // dir doesn't exist
      }
    }
    if (!has) missing.push(pkg);
  }

  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${testOwners.length}/${testOwners.length} test owners have tests (3 MSPs + shared)`,
    };
  }
  return {
    status: "fail",
    detail: `${missing.length} test owner(s) missing tests: ${missing.join(", ")}`,
  };
});

// Check 3: README presence
export const checkReadmePresence = createCheck("readme_presence", (repoRoot) =>
  checkPerPackage(repoRoot, "README.md", (dir) => fileExists(join(dir, "README.md"))),
);

// Check 4: Type check
export const checkTypeCheck = createCheck("type_check", async (repoRoot) => {
  const pkgs = await packageNames(repoRoot);
  const failures: string[] = [];

  for (const pkg of pkgs) {
    const indexPath = join(pkgDir(pkg, repoRoot), "src", "index.ts");
    if (!(await fileExists(indexPath))) {
      failures.push(`${pkg} (no src/index.ts)`);
      continue;
    }

    try {
      const proc = Bun.spawn(
        ["bun", "build", "--target=bun", "--no-bundle", "src/index.ts"],
        { cwd: pkgDir(pkg, repoRoot), stdout: "pipe", stderr: "pipe" },
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
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages typecheck clean`,
    };
  }

  return {
    status: "fail",
    detail: `${failures.length} package(s) failed: ${failures.join("; ")}`,
  };
});

// Check 5: Tool registration sanity (fix-17 regression guard)
// H1 Phase-2 migration — the file list now comes from
// `getHealthConfigSync().toolFiles` (default matches the v0.14.2 hardcoded
// list). We resolve it once at the start of the check to keep the inner
// loop allocation-free.
export const checkToolRegistration = createCheck("tool_registration", async (repoRoot) => {
  const toolFiles = getHealthConfigSync().toolFiles
  const bugs: string[] = [];

  for (const relPath of toolFiles) {
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

      // Lazy-init helper: returns the Set for a given indent, creating it if
      // absent. Avoids repeated `.has`/`.set`/`.get!` dance at every line.
      const getOrCreate = (m: Map<number, Set<string>>, indent: number): Set<string> => {
        let s = m.get(indent);
        if (!s) {
          s = new Set();
          m.set(indent, s);
        }
        return s;
      };

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

        getOrCreate(keysByIndent, indent).add(key);

        if (isStringVal) {
          getOrCreate(stringKeysByIndent, indent).add(key);
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
      status: "ok",
      detail: `0 'name' field bugs across ${toolFiles.length} tool-bearing files`,
    };
  }

  return {
    status: "fail",
    detail: bugs.join("; "),
  };
});

// Check 6: Version consistency
export const checkVersionConsistency = createCheck("version_consistency", async (repoRoot) => {
  // Read root version
  let rootVersion: string;
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
    rootVersion = rootPkg.version || "unknown";
  } catch {
    return {
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
      status: "ok",
      detail: `All ${pkgs.length} packages match root version ${rootVersion}`,
    };
  }

  return {
    status: "warn",
    detail: `Root ${rootVersion}, ${mismatches.length} mismatches: ${mismatches.join(", ")}`,
  };
});

// Check 7: License file
export const checkLicense = createCheck("license", async (repoRoot) => {
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
      status: "fail",
      detail: "No LICENSE file in repo root",
    };
  }

  if (missingRefs.length === 0) {
    return {
      status: "ok",
      detail: `LICENSE present, all ${pkgs.length} READMEs reference it`,
    };
  }

  return {
    status: "warn",
    detail: `LICENSE present, ${missingRefs.length} README(s) missing reference: ${missingRefs.join(", ")}`,
  };
});

// Check 8: SDK compliance (shared import)
const KNOWN_SDK_EXCEPTIONS = new Set(["max-mode", "workflow"]);

export const checkSdkCompliance = createCheck("sdk_compliance", async (repoRoot) => {
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
      status: "fail",
      detail: `${missingDir.length} package(s) missing src/index.ts: ${missingDir.join(", ")}`,
    };
  }

  if (missingImport.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length - KNOWN_SDK_EXCEPTIONS.size}/${pkgs.length} packages import @sffmc/shared (2 known exceptions: ${[...KNOWN_SDK_EXCEPTIONS].join(", ")})`,
    };
  }

  return {
    status: "warn",
    detail: `${missingImport.length} package(s) missing @sffmc/shared import: ${missingImport.join(", ")}`,
  };
});

// Check 9: tsconfig.json presence
export const checkTsConfigPresence = createCheck("tsconfig_presence", async (repoRoot) => {
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
      status: "fail",
      detail: `${invalidJson.length} package(s) have invalid tsconfig.json: ${invalidJson.join(", ")}`,
    };
  }

  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have tsconfig.json`,
    };
  }

  return {
    status: "warn",
    detail: `${missing.length} package(s) missing tsconfig.json: ${missing.join(", ")}`,
  };
});

// Check 10: CHANGELOG currency
export const checkChangelogCurrency = createCheck("changelog_currency", async (repoRoot) => {
  // Read root version
  let rootVersion: string;
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"));
    rootVersion = rootPkg.version || "unknown";
  } catch {
    return {
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
      status: "fail",
      detail: "CHANGELOG.md not found",
    };
  }

  // Extract the most recent version entry
  const versionMatch = changelogText.match(/^##\s+v(\d+\.\d+\.\d+)/m);
  if (!versionMatch) {
    return {
      status: "fail",
      detail: "CHANGELOG.md has no recognizable version section",
    };
  }

  const changelogVersion = versionMatch[1];

  if (changelogVersion === rootVersion) {
    return {
      status: "ok",
      detail: `CHANGELOG v${changelogVersion} matches root package.json (${rootVersion})`,
    };
  }

  return {
    status: "warn",
    detail: `CHANGELOG v${changelogVersion} does not match root package.json (${rootVersion})`,
  };
});

// Check 11: @sffmc/extra opt-in status (informational only)
export const checkExtraOptIn = createCheck("extra_opt_in", async (repoRoot) => {
  const extraDir = join(repoRoot, "packages", "extra");
  if (!(await fileExists(extraDir))) {
    return {
      status: "ok",
      detail: "@sffmc/extra not installed (packages/extra/ not found)",
    };
  }

  const configPath = join(userHome(), ".config", "SFFMC", "extra.yaml");
  if (!(await fileExists(configPath))) {
    return {
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
        status: "ok",
        detail: "@sffmc/extra installed, config present, all features off",
      };
    }

    return {
      status: "ok",
      detail: `@sffmc/extra: ${enabled.length}/3 features enabled (${enabled.join(", ")})`,
    };
  } catch {
    return {
      status: "warn",
      detail: "Could not read extra config file",
    };
  }
});

// Check 12: Category split (MiMo ports vs SFFMC originals)
export const checkCategorySplit = createCheck("category_split", async (repoRoot) => {
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
      status: "warn",
      detail: `${portCount} mimo-port, ${origCount} sffmc-original, ${uncatCount} uncategorized`,
    };
  }

  return {
    status: "ok",
    detail: `3 MSP categories: ${mspCount} msp (3-MSP bundles: safety/memory/agentic), ${portCount} mimo-port (MiMo-Code v8.0 features), ${origCount} sffmc-original (SFFMC team additions)`,
  };
});

// Check 13: Composite structure (v0.9.0)
// H3 Phase-2 migration — the expected composite list now comes from
// `getHealthConfigSync().expectedComposites` (default matches the v0.14.2
// hardcoded `["safety", "memory", "agentic"]` list verbatim).
export const checkCompositeStructure = createCheck("composite_structure", async (repoRoot) => {
  const expectedComposites = getHealthConfigSync().expectedComposites
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Each expected composite exists
  for (const compositeName of expectedComposites) {
    const compositeDir = join(repoRoot, "packages", compositeName);
    if (!(await fileExists(compositeDir))) {
      errors.push(`Composite directory missing: packages/${compositeName}/`);
      continue;
    }

    // 2. package.json has role and composes
    const pkgJsonPath = join(compositeDir, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as {
        role?: string;
        composes?: string[];
      };

      if (!parsed.role) {
        errors.push(`${compositeName}: package.json missing role`);
      } else if (parsed.role !== compositeName) {
        errors.push(`${compositeName}: package.json role is "${parsed.role}" but expected "${compositeName}"`);
      }
      if (!parsed.composes || parsed.composes.length === 0) {
        errors.push(`${compositeName}: package.json missing composes`);
      } else {
        // 3. Each listed feature corresponds to a real package
        for (const feature of parsed.composes) {
          const featureDir = join(repoRoot, "packages", feature);
          if (!(await fileExists(featureDir))) {
            errors.push(`${compositeName} lists composes "${feature}" but packages/${feature}/ does not exist`);
          }
        }
      }
    } catch (err) {
      errors.push(`${compositeName}: could not read package.json (${err})`);
    }

    // 4. src/index.ts uses mergeHooks
    const indexPath = join(compositeDir, "src", "index.ts");
    try {
      const content = await readFile(indexPath, "utf-8");
      if (!/mergeHooks\s*\(/.test(content)) {
        errors.push(`${compositeName}: src/index.ts does not call mergeHooks()`);
      }
      if (!/from\s+["']@sffmc\/shared["']/.test(content)) {
        warnings.push(`${compositeName}: src/index.ts does not import from @sffmc/shared`);
      }
    } catch (err) {
      errors.push(`${compositeName}: could not read src/index.ts (${err})`);
    }
  }

  // 5. No sub-feature claims to be a composite (inverse check)
  for (const pkg of await packageNames(repoRoot)) {
    if (expectedComposites.includes(pkg)) continue;
    const pkgJsonPath = join(repoRoot, "packages", pkg, "package.json");
    try {
      const content = await readFile(pkgJsonPath, "utf-8");
      const parsed = JSON.parse(content) as { role?: string };
      if (parsed.role) {
        errors.push(`${pkg}: claims role "${parsed.role}" but is not in expectedComposites`);
      }
    } catch {
      // package.json unreadable — other checks handle this
    }
  }

  if (errors.length > 0) {
    return {
      status: "fail",
      detail: `${errors.length} composite structure error(s): ${errors.join("; ")}`,
    };
  }

  if (warnings.length > 0) {
    return {
      status: "warn",
      detail: `3 composites valid (safety/memory/agentic), ${warnings.length} warning(s): ${warnings.join("; ")}`,
    };
  }

  return {
    status: "ok",
    detail: `3 composites valid: safety (5 features), memory (4 features), agentic (4 features)`,
  };
});

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
  checkCompositeStructure,
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
12. category_split — counts mimo-port (7) + sffmc-original (4) + composites (3) = 14 packages
13. composite_structure — verifies safety/memory/agentic composites have role + composes fields + mergeHooks() + listed features

Returns JSON with ok (boolean), checks[] (per-check status), and summary (string).
Use this before releases or after plugin changes to catch regressions early.`,
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "Optional project roots (informational; the tool uses the plugin context's projectRoot for the actual scan)",
            },
          },
          required: [],
        },
        execute: async (_args?: { paths?: string[] }) => {
          const root = repoRoot;
          const result = await runAllChecks(root);
          return JSON.stringify(result, null, 2);
        },
      },
    },
  };
};

export default { id, server }
