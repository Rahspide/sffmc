// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Health config — `~/.config/SFFMC/health.yaml` schema + module-level cache
// + symbol-registry test reset. Mirrors the pattern in
// `packages/runtime/src/constants.ts` (`ensureWorkflowConfig`,
// `getWorkflowConfigSync`, `__setWorkflowConfig`).
//
// Behavior preserved from v0.14.x: when no YAML is present the defaults
// match the hardcoded values verbatim. Each check reads via
// `getHealthConfigSync().X` so per-test reset (`__setHealthConfig`)
// takes effect immediately.

import { loadConfig } from "@sffmc/utilities";

/** composite file list — repo-relative paths of files that register a tool (used by
 *  `checkToolRegistration` to scan for the fix-17 `name` field bug). */
export interface HealthConfig {
  /** composite file list — tool-registration scan targets (fix-17 regression guard). */
  toolFiles: readonly string[];
  /** safeMultiHooks flag — hook names that are SAFE for multiple plugins to register
   *  (`checkHookConflicts` whitelists these and treats all others as
   *  real conflicts). */
  safeMultiHooks: readonly string[];
  /** expected composite list — composites the monorepo is expected to ship (used by
   *  `checkCompositeStructure` for forward-validation of the
   *  safety/memory/agentic layout). */
  expectedComposites: readonly string[];
}

export const DEFAULT_HEALTH_CONFIG: HealthConfig = {
  // composite file list — matches the v0.14.x hardcoded TOOL_FILES at src/index.ts:280-287
  toolFiles: [
    "packages/cognition/src/compose/src/index.ts",       // compose_skill
    "packages/runtime/src/tool.ts",                      // workflow
    "packages/cognition/src/health/src/index.ts",        // sffmc_health
    "packages/memory/src/extra/checkpoint.ts",           // extra_checkpoint
    "packages/memory/src/extra/judge.ts",                // extra_judge
    "packages/memory/src/extra/dream.ts",                // extra_dream
  ],
  // safeMultiHooks flag — matches the v0.14.x hardcoded `new Set([...])` at src/index.ts:133-149
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
  // expected composite list — v0.15.4: safety + memory (agentic was dissolved in
  // v0.15.0; its members are now internal sub-folders of safety/memory/
  // runtime/cognition, NOT workspace packages).
  expectedComposites: ["safety", "memory"],
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

const __SET_HEALTH_CONFIG_SYMBOL = Symbol.for("@sffmc/cognition.__setHealthConfig")
;(globalThis as Record<symbol, unknown>)[__SET_HEALTH_CONFIG_SYMBOL] = __setHealthConfig

/** Sync accessor — returns the cached config or the defaults if the YAML
 *  hasn't been loaded yet. Use this in hot paths where awaiting is not
 *  an option; call `ensureHealthConfig()` at startup to populate. */
export function getHealthConfigSync(): HealthConfig {
  return _healthConfig ?? DEFAULT_HEALTH_CONFIG
}
