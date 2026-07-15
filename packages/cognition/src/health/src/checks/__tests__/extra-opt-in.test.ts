// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkExtraOptIn` (../extra-opt-in.ts). This check is now
// informational only — `@sffmc/utilities` became a permanent library at
// v0.15.0 (the old opt-in bundle was dissolved). The check returns `ok`
// unconditionally; the function itself is kept only so downstream log
// scrapers that grep for "extra_opt_in" still find something to read.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkExtraOptIn } from "../extra-opt-in.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_extra_opt_in", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkExtraOptIn(REPO_ROOT)
    expect(result.name).toBe("extra_opt_in")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo", async () => {
    const result = await checkExtraOptIn(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/permanent library/)
  })

  test("returns ok even against an empty tmpdir (informational)", async () => {
    // The check does not inspect repoRoot — it returns ok unconditionally.
    // Verifying against an empty dir guards against future regressions where
    // someone re-introduces filesystem logic.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-extra-optin-"))
    try {
      const result = await checkExtraOptIn(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/v0\.15\.0/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok against a non-existent path (does not read filesystem)", async () => {
    const result = await checkExtraOptIn("/nonexistent/path/that/does/not/exist/at/all")
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/no opt-in required/)
  })
})