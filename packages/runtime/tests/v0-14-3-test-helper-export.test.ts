// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// v0.14.3 — D-1: __setWorkflowConfig test escape hatch migration.
//
// The `__setWorkflowConfig()` function in `packages/workflow/src/constants.ts`
// is test-only — it mutates the module-level workflow config cache to
// allow tests to inject YAML overrides without touching disk. It was
// always prefixed with `__` to signal "do not use", but it was still
// importable from `@sffmc/runtime/src/constants.ts` by any consumer that
// knew the path.
//
// Fix shape:
//   - new file `packages/workflow/tests/_test-helpers/config-cache.ts`
//     re-exports the function (the only legit path now)
//   - in `constants.ts`, gate the export behind a NODE_ENV === "test"
//     check OR delete the export entirely
//   - migrate the 18 call sites in `tests/phase1-hardcode-config.test.ts`
//     and `tests/w10-w14-hardcode-runtime.test.ts` to import from the new
//     test-helpers path
//
// These tests DEFINE the desired v0.14.3 behavior. They will FAIL on the
// v0.14.2 baseline and PASS after D-1 ships.

import { describe, test, expect } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"

describe("v0.14.3 D-1: __setWorkflowConfig test escape hatch migration", () => {
  test("test-helpers/config-cache.ts exists", () => {
    // The new location must exist before any test can import from it.
    const helperPath = path.join(import.meta.dir, "_test-helpers", "config-cache.ts")
    expect(existsSync(helperPath)).toBe(true)
  })

  test("test-helpers/config-cache.ts exports __setWorkflowConfig", async () => {
    const helperPath = path.join(import.meta.dir, "_test-helpers", "config-cache.ts")
    // Dynamic import: succeeds only if the file exists AND exports the function.
    const mod = await import(helperPath) as Record<string, unknown>
    expect(typeof mod.__setWorkflowConfig).toBe("function")
  })

  test("__setWorkflowConfig is no longer exported from @sffmc/runtime/src/constants.ts", async () => {
    // Dynamic import of the production module — __setWorkflowConfig should
    // NOT be reachable from the production `src/constants.ts` surface.
    //
    // Cleanup review: this test was tautological in v1 — it accepted
    // either undefined or function. The real invariant is: production
    // paths don't get this function. The test file's NODE_ENV is "test"
    // (bun:test sets it), so a NODE_ENV-gated export would still appear.
    // The migration's true success criterion is the file/grep check in
    // test #4 below (call sites use the new helper path).
    //
    // For this assertion we check the import returns an object without
    // `__setWorkflowConfig` — i.e., it's not in the namespace at all.
    const constantsPath = path.join(import.meta.dir, "..", "src", "constants.ts")
    const mod = await import(constantsPath) as Record<string, unknown>
    // Either: the symbol is absent entirely (preferred — function removed
    // from constants.ts), OR: it's present but is not callable (would mean
    // someone added a stub without removing the export).
    expect(typeof mod.__setWorkflowConfig).not.toBe("function")
  })

  test("the 2 known call-site test files have been migrated to the new helper path", async () => {
    // Use bun's text-search via grep — no need to import the test files
    // (which would re-run them). We just verify the source files no
    // longer reference the old import path.
    const { readFileSync } = await import("node:fs")
    const oldPath = "../src/constants.ts"
    const newPath = "./_test-helpers/config-cache.ts"

    const phase1 = readFileSync(
      path.join(import.meta.dir, "phase1-hardcode-config.test.ts"),
      "utf-8",
    )
    expect(phase1.includes(newPath)).toBe(true)

    const w10w14 = readFileSync(
      path.join(import.meta.dir, "w10-w14-hardcode-runtime.test.ts"),
      "utf-8",
    )
    expect(w10w14.includes(newPath)).toBe(true)
    // Anti-regression: old path should NOT appear in migrated test files.
    expect(phase1.includes(oldPath)).toBe(false)
    expect(w10w14.includes(oldPath)).toBe(false)
  })
})
