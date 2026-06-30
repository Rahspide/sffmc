// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../LICENSE
//
// Test-only re-export of src/index.ts. Production code must NOT
// import this — the file is intentionally placed under tests/ and its
// only purpose is to give tests a single import path for the compose
// config surface (v0.14.3 D-1).
//
// The shim pulls most symbols through normal `export ... from`
// re-exports, plus a Symbol-registry indirection for __setComposeConfig
// (which is not publicly exported from src/index.ts). This means:
//   - src/index.ts does NOT add a public export of __setComposeConfig
//   - this shim DOES export __setComposeConfig as a callable function
//   - production code that imports this file fails the runtime check
//     below if src/index.ts was never loaded (Symbol not registered)

const __SET_COMPOSE_CONFIG_SYMBOL = Symbol.for("@sffmc/cognition.__setComposeConfig")

// Re-export every public symbol from src/index.ts so test files
// have exactly one import path.
export {
  DEFAULT_COMPOSE_CONFIG,
  DEFAULT_SKILLS,
  DEFAULT_SKILLS_DIR,
  ensureComposeConfig,
  getComposeConfigSync,
  getComposeSkillsDir,
  getComposeValidSkills,
  type ComposeConfig,
  type DefaultSkillName,
} from "../../../src/compose/src/index.ts"

/** Reset the cached compose config to `cfg` (or clear it with `null`).
 *  Mirrors the test-only behavior of the private
 *  `__setComposeConfig()` in `src/index.ts`. The implementation is
 *  reached through a Symbol registry populated by src/index.ts at
 *  module load — not through a public export. */
export function __setComposeConfig(cfg: unknown): void {
  const fn = (globalThis as Record<symbol, unknown>)[__SET_COMPOSE_CONFIG_SYMBOL] as
    | ((c: unknown) => void)
    | undefined
  if (!fn) {
    throw new Error(
      "__setComposeConfig: src/index.ts was not loaded before this test " +
        "helper. Import something from ../../src/index.ts in your test " +
        "file (or its transitive deps) to populate the Symbol registry.",
    )
  }
  fn(cfg)
}
