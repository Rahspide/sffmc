// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkTestPresence` (../test-presence.ts). After the v0.9.0
// composite restructure, only composites (role-bearing packages) and the
// shared infra package are expected to own tests; module packages are
// "code-only" and inherit tests from their owning composite.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkTestPresence } from "../test-presence.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_test_presence", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkTestPresence(REPO_ROOT)
    expect(result.name).toBe("test_presence")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (composites have tests)", async () => {
    const result = await checkTestPresence(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/test owners have tests/)
  })

  test("fails when a composite package is missing *.test.ts", async () => {
    // Tmpdir with a composite (role-bearing) package that has NO .test.ts file.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-test-presence-"))
    try {
      const pkg = join(tmp, "packages", "mycomposite")
      mkdirSync(join(pkg, "src"), { recursive: true })
      // package.json with role → composite
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "mycomposite", version: "1.0.0", role: "mycomposite" }))
      // .ts source but no .test.ts
      writeFileSync(join(pkg, "src", "index.ts"), "export const x = 1")

      const result = await checkTestPresence(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/missing tests.*mycomposite/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("module packages without tests are NOT counted as missing", async () => {
    // A non-composite module package (no role field) without tests should NOT
    // be flagged — only composites + shared are test owners.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-test-presence-"))
    try {
      const modPkg = join(tmp, "packages", "boring-module")
      mkdirSync(join(modPkg, "src"), { recursive: true })
      writeFileSync(join(modPkg, "package.json"), JSON.stringify({ name: "boring-module", version: "1.0.0" }))
      // No .test.ts, no role → should not be flagged
      writeFileSync(join(modPkg, "src", "index.ts"), "export const x = 1")

      const result = await checkTestPresence(tmp)
      expect(result.status).toBe("ok")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
