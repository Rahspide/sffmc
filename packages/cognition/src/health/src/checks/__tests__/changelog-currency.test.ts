// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkChangelogCurrency` (../changelog-currency.ts). The top
// version in `CHANGELOG.md` must match the root `package.json`. Optionally,
// `CHANGELOG.ru.md` (bilingual promise, v0.15.0+) should match too — but
// that part is warn-only because translations can lag a release by a session.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkChangelogCurrency } from "../changelog-currency.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_changelog_currency", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkChangelogCurrency(REPO_ROOT)
    expect(result.name).toBe("changelog_currency")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (CHANGELOG matches root)", async () => {
    const result = await checkChangelogCurrency(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/CHANGELOG v\d+\.\d+\.\d+ matches root package\.json/)
  })

  test("warns when CHANGELOG.md top version lags the root version", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-changelog-stale-"))
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", version: "2.0.0" }))
      writeFileSync(join(tmp, "CHANGELOG.md"), "## v1.0.0 (2026-01-01)\n\nOld release.\n")

      const result = await checkChangelogCurrency(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/CHANGELOG v1\.0\.0 does not match root package\.json \(2\.0\.0\)/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("fails when CHANGELOG.md has no recognizable version section", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-changelog-nover-"))
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }))
      // No `## vX.Y.Z` header
      writeFileSync(join(tmp, "CHANGELOG.md"), "# Changelog\n\nNo version markers yet.\n")

      const result = await checkChangelogCurrency(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/no recognizable version section/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("fails when root package.json is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-changelog-noroot-"))
    try {
      writeFileSync(join(tmp, "CHANGELOG.md"), "## v1.0.0 (2026-01-01)\n")

      const result = await checkChangelogCurrency(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/Could not read root package\.json/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("warns when bilingual CHANGELOG.ru.md is missing (informational)", async () => {
    // Real repo HAS CHANGELOG.ru.md, so we need a tmpdir where only the
    // English file matches the root and the Russian file is absent.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-changelog-only-en-"))
    try {
      writeFileSync(join(tmp, "package.json"), JSON.stringify({ name: "root", version: "1.0.0" }))
      writeFileSync(join(tmp, "CHANGELOG.md"), "## v1.0.0 (2026-01-01)\n")
      // No CHANGELOG.ru.md

      const result = await checkChangelogCurrency(tmp)
      // English matches, but bilingual gap → warn
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/CHANGELOG\.ru\.md missing/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})