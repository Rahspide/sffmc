// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkVersionConsistency` (../version-consistency.ts). Compares
// every package's `version` field against the root `package.json`. Match ⇒
// ok. Any mismatch ⇒ warn (not fail — the check is informational because
// release bumps occasionally lag across packages during a release).

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkVersionConsistency } from "../version-consistency.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_version_consistency", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkVersionConsistency(REPO_ROOT)
    expect(result.name).toBe("version_consistency")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok when all package versions match the root version", async () => {
    const result = await checkVersionConsistency(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/All \d+ packages match root version/)
  })

  test("returns warn when one package version differs from the root", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-version-mismatch-"))
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }))
      const pkgA = join(tmp, "packages", "alpha")
      const pkgB = join(tmp, "packages", "beta")
      mkdirSync(pkgA, { recursive: true })
      mkdirSync(pkgB, { recursive: true })
      // alpha matches root, beta mismatches
      writeFileSync(join(pkgA, "package.json"), JSON.stringify({ name: "alpha", version: "1.0.0" }))
      writeFileSync(join(pkgB, "package.json"), JSON.stringify({ name: "beta", version: "0.9.0" }))

      const result = await checkVersionConsistency(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/1 mismatches.*beta/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns fail when root package.json is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-version-noroot-"))
    try {
      mkdirSync(join(tmp, "packages", "lonely"), { recursive: true })
      writeFileSync(join(tmp, "packages", "lonely", "package.json"), JSON.stringify({ name: "lonely", version: "1.0.0" }))

      const result = await checkVersionConsistency(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/Could not read root package\.json/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok against an empty repo (no packages to compare)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-version-empty-"))
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }))

      const result = await checkVersionConsistency(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/All 0 packages match root version 1\.0\.0/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})