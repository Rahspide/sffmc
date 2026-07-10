// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Cached runtime config and config-aware getters. Has module-level side
// effects: registers `__setWorkflowConfig` on `globalThis` under
// `Symbol.for("@sffmc/runtime.__setWorkflowConfig")` so the test shim
// at `tests/_test-helpers/config-cache.ts` can invoke it without
// `src/constants.ts` having to publicly export it
// (see v0.14.3 D-1; verified by `v0-14-3-test-helper-export.test.ts`).
//
// Imported via `constants.ts` (barrel) by production code; the cache is
// populated by calling `ensureWorkflowConfig()` at startup and queried
// by the sync getters below in hot paths where awaiting is impractical.

import { loadConfig } from "@sffmc/utilities"
import { DEFAULT_WORKFLOW_EXTENDED_CONFIG, type WorkflowExtendedConfig } from "./constants-defaults.ts"

// Module-level cache for the loaded config. Populated on  call to
// `ensureWorkflowConfig()`. Sync getters fall back to defaults until then.
let _workflowConfig: WorkflowExtendedConfig | null = null
let _workflowConfigPromise: Promise<WorkflowExtendedConfig> | null = null

/** Load `~/.config/SFFMC/workflow.yaml` once and cache the result.
 *  Idempotent — concurrent callers receive the same promise.
 *
 *  @param opts.configHome — override the config directory (useful for
 *    tests that need an isolated config file). Defaults to
 *    `~/.config/SFFMC`. */
export function ensureWorkflowConfig(
  opts?: { configHome?: string },
): Promise<WorkflowExtendedConfig> {
  if (_workflowConfig) return Promise.resolve(_workflowConfig)
  if (!_workflowConfigPromise) {
    _workflowConfigPromise = loadConfig<Partial<WorkflowExtendedConfig>>(
      "workflow",
      DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      { configHome: opts?.configHome },
    ).then((loaded) => {
      const merged: WorkflowExtendedConfig = {
        ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
        ...loaded,
      }
      _workflowConfig = merged
      return merged
    })
  }
  return _workflowConfigPromise
}

/** Test helper — reset the cached config. Useful for unit tests that
 *  want to inject a custom config without round-tripping through YAML.
 *  NOT exported (v0.14.3 D-1) — tests reach this function via the
 *  test-helper shim at `tests/_test-helpers/config-cache.ts`, which
 *  looks up the implementation through a Symbol registry rather than
 *  a public export. The Symbol is namespaced under `@sffmc/runtime.*`
 *  to avoid collisions. */
function __setWorkflowConfig(cfg: WorkflowExtendedConfig | null): void {
  _workflowConfig = cfg
  _workflowConfigPromise = null
}

/** v0.14.x D-1 — Symbol-keyed registration so the test shim can find
 *  `__setWorkflowConfig` without `src/constants.ts` having to export it
 *  publicly. Registered at module load; the shim looks it up via
 *  `Symbol.for("@sffmc/runtime.__setWorkflowConfig")`. */
const __SET_WORKFLOW_CONFIG_SYMBOL = Symbol.for("@sffmc/runtime.__setWorkflowConfig")
;(globalThis as Record<symbol, unknown>)[__SET_WORKFLOW_CONFIG_SYMBOL] = __setWorkflowConfig

/** Sync accessor — returns the cached config or the defaults if the
 *  YAML hasn't been loaded yet. Use this in hot paths where awaiting is
 *  not an option; call `ensureWorkflowConfig()` at startup to populate. */
export function getWorkflowConfigSync(): WorkflowExtendedConfig {
  return _workflowConfig ?? DEFAULT_WORKFLOW_EXTENDED_CONFIG
}

// Config-aware getters. Each prefers the YAML override and falls back to
// the exported module-level constant (the prior hardcoded value).

export function getScriptDeadlineMs(): number {
  return getWorkflowConfigSync().scriptDeadlineMs
}

export function getSandboxMemoryMB(): number {
  return getWorkflowConfigSync().sandboxMemoryMB
}

export function getSandboxStackSize(): number {
  return getWorkflowConfigSync().sandboxStackSize
}

export function getWorkflowSearchDirs(): readonly string[] {
  return getWorkflowConfigSync().searchDirs
}

export function getWorkflowDataDir(): string {
  return getWorkflowConfigSync().dataDir
}

export function getMaxInstructions(): number {
  return getWorkflowConfigSync().maxInstructions
}

export function getMaxConcurrentAgents(): number {
  return getWorkflowConfigSync().maxConcurrentAgents
}

// sandbox pump timings — sandbox pump timings. The defaults match the prior hardcoded
// values in `sandbox.ts` (FAST_MS=1, SLOW_MS=50, FAST_WINDOW=50). These
// getters prefer the YAML override and fall back to the defaults above.

export function getSandboxFastMs(): number {
  return getWorkflowConfigSync().sandboxFastMs
}

export function getSandboxSlowMs(): number {
  return getWorkflowConfigSync().sandboxSlowMs
}

export function getSandboxFastWindow(): number {
  return getWorkflowConfigSync().sandboxFastWindow
}

// scheduleFlush debounce window. The default matches the prior
// hardcoded value in `runtime.ts:scheduleFlush` (`setTimeout(..., 250)`).
//
// IMPORTANT: runtime.ts is off-limits per the v0.14.x hotfix policy.
// This getter is defined NOW so the consumer wiring (replacing the
// literal `250` in runtime.ts with `getFlushDebounceMs()`) can be done
// in a follow-up hotfix commit. Until then, the runtime ignores YAML
// overrides for this field — the getter is consumed only by callers
// outside runtime.ts (none today, future consumers expected).

export function getFlushDebounceMs(): number {
  return getWorkflowConfigSync().flushDebounceMs
}

// Journal fsync coalescing window. The default matches the
// prior hardcoded `const FSYNC_COALESCE_MS = 50` in `persistence.ts`.
// This getter is used by `persistence.ts:scheduleFsync` (replacing
// the local const with `getFsyncCoalesceMs()`).

export function getFsyncCoalesceMs(): number {
  return getWorkflowConfigSync().fsyncCoalesceMs
}

export function getDbFilename(): string {
  return getWorkflowConfigSync().dbFilename
}
