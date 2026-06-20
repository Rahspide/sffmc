// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Test-only re-export of src/constants.ts. Production code must NOT
// import this — the file is intentionally placed under tests/ and its
// only purpose is to give tests a single import path for the workflow
// config surface (v0.14.3 D-1).
//
// The shim pulls most symbols through normal `export ... from`
// re-exports, plus a Symbol-registry indirection for __setWorkflowConfig
// (which is no longer publicly exported from constants.ts). This means:
//   - constants.ts does NOT add a public export of __setWorkflowConfig
//     (test #3 of v0-14-3-test-helper-export.test.ts passes)
//   - this shim DOES export __setWorkflowConfig as a callable function
//     (test #2 passes)
//   - production code that imports this file fails the runtime check
//     below if constants.ts was never loaded (Symbol not registered)

const __SET_WORKFLOW_CONFIG_SYMBOL = Symbol.for("@sffmc/workflow.__setWorkflowConfig")

// Re-export every public symbol from src/constants.ts so test files
// have exactly one import path. This makes the migration check in
// v0-14-3-test-helper-export.test.ts straightforward: `from
// "../src/constants.ts"` must not appear in any migrated test file.
export {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  SCRIPT_DEADLINE_MS,
  WORKFLOW_LIMITS,
  WORKFLOW_SEARCH_DIRS,
  MAX_LIFECYCLE_AGENTS,
  MAX_DEPTH_DEFAULT,
  ensureWorkflowConfig,
  getWorkflowConfigSync,
  getScriptDeadlineMs,
  getSandboxMemoryMB,
  getSandboxStackSize,
  getWorkflowSearchDirs,
  getWorkflowDataDir,
  getMaxConcurrentAgents,
  getSandboxFastMs,
  getSandboxSlowMs,
  getSandboxFastWindow,
  getFlushDebounceMs,
  type WorkflowExtendedConfig,
} from "../../src/constants.ts"

/** Reset the cached workflow config to `cfg` (or clear it with `null`).
 *  Mirrors the test-only behavior of the private
 *  `__setWorkflowConfig()` in `src/constants.ts`. The implementation
 *  is reached through a Symbol registry populated by constants.ts at
 *  module load — not through a public export. */
export function __setWorkflowConfig(cfg: unknown): void {
  const fn = (globalThis as Record<symbol, unknown>)[__SET_WORKFLOW_CONFIG_SYMBOL] as
    | ((c: unknown) => void)
    | undefined
  if (!fn) {
    throw new Error(
      "__setWorkflowConfig: src/constants.ts was not loaded before this test " +
        "helper. Import something from ../src/constants.ts in your test file " +
        "(or its transitive deps) to populate the Symbol registry.",
    )
  }
  fn(cfg)
}
