// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Public API surface for `@sffmc/cognition/health`. After the v0.16.0
// decomposition this file is a thin orchestrator — all 14 checks live in
// `checks/*.ts`, the shared helpers in `helpers.ts`, the config in
// `config.ts`. This file re-exports the public schema, wires the 14 checks
// into `ALL_CHECKS` / `runAllChecks`, and provides the plugin entry
// (`id` / `server`).
//
// Why a thin orchestrator: easier to read (1 page vs 23 pages), easier
// to add a new check (one new file in `checks/`, one import here), and
// per-check unit tests live next to the check implementation.

import type { PluginContext } from "@sffmc/utilities";

import { createCheck, type CheckFn, type CheckResult, type HealthResult } from "./check-factory.ts";

// Re-export the public schema so consumers (scripts, tests, agentic composite)
// can `import { CheckResult, HealthResult, CheckFn } from "@sffmc/cognition"`.
export type { CheckResult, HealthResult, CheckFn } from "./check-factory.ts";

// Re-export the config helpers — some tests + the legacy health consumer
// in `packages/cognition/src/index.ts` call `getHealthConfigSync` directly,
// and tests reach DEFAULT_HEALTH_CONFIG.
export {
  ensureHealthConfig,
  getHealthConfigSync,
  DEFAULT_HEALTH_CONFIG,
  type HealthConfig,
} from "./config.ts";

import { checkHookConflicts } from "./checks/hook-conflicts.ts";
import { checkTestPresence } from "./checks/test-presence.ts";
import { checkReadmePresence } from "./checks/readme-presence.ts";
import { checkTypeCheck } from "./checks/type-check.ts";
import { checkToolRegistration } from "./checks/tool-registration.ts";
import { checkVersionConsistency } from "./checks/version-consistency.ts";
import { checkLicense } from "./checks/license.ts";
import { checkSdkCompliance } from "./checks/sdk-compliance.ts";
import { checkTsConfigPresence } from "./checks/tsconfig-presence.ts";
import { checkChangelogCurrency } from "./checks/changelog-currency.ts";
import { checkExtraOptIn } from "./checks/extra-opt-in.ts";
import { checkCategorySplit } from "./checks/category-split.ts";
import { checkCompositeStructure } from "./checks/composite-structure.ts";

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

export const id = "@sffmc/cognition"
export const server = async (ctx: PluginContext) => {
  const repoRoot = (ctx as Record<string, unknown>).projectRoot as string;

  return {
    tool: {
      sffmc_health: {
        description: `Run 13 diagnostic checks on the SFFMC monorepo to verify plugin health.

Checks performed (one per file in packages/cognition/src/health/src/checks/):
1. hook_conflicts — invokes scripts/audit-load-order.py, reports hook conflicts between plugins
2. test_presence — verifies every package has at least one *.test.ts file
3. readme_presence — verifies every package has a README.md
4. type_check — runs bun build --no-bundle per package
5. tool_registration — scans for 'name' field bug in tool definitions (fix-17 regression, 6 tool files)
6. version_consistency — compares root package.json version against all plugin versions
7. license — verifies LICENSE exists and is referenced from all READMEs
8. sdk_compliance — verifies packages import from @sffmc/utilities (2 known exceptions: max-mode, workflow)
9. tsconfig_presence — verifies each package has tsconfig.json (migration-progress check)
10. changelog_currency — verifies CHANGELOG.md version matches root package.json (and bilingual CHANGELOG.ru.md sync)
11. extra_opt_in — reports @sffmc/utilities opt-in status (informational; 3 opt-in features off by default)
12. category_split — counts mimo-port + sffmc-original + composites = total packages
13. composite_structure — verifies safety/memory composites have role + composes fields + mergeHooks() + listed features

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
