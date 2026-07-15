// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkLicense` (../license.ts). The check verifies:
//   1. A root LICENSE file exists.
//   2. Every package README.md mentions LICENSE, MIT, or "license".
//
// If LICENSE is missing ⇒ fail (hard contract). If LICENSE exists but some
// READMEs do not reference it ⇒ warn (cosmetic).

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkLicense } from "../license.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_license", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkLicense(REPO_ROOT)
    expect(result.name).toBe("license")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (LICENSE + every README references it)", async () => {
    const result = await checkLicense(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/LICENSE present, all \d+ READMEs reference it/)
  })

  test("fails when root LICENSE is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-license-nolicense-"))
    try {
      // No LICENSE at root
      const pkg = join(tmp, "packages", "foo")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }))
      writeFileSync(join(pkg, "README.md"), "# foo\n\nMIT licensed\n")

      const result = await checkLicense(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/No LICENSE file in repo root/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("warns when LICENSE exists but a README does not reference it", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-license-noreadme-ref-"))
    try {
      writeFileSync(join(tmp, "LICENSE"), "MIT License\n\nCopyright (c) 2026\n")
      const pkg = join(tmp, "packages", "foo")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "foo", version: "1.0.0" }))
      // README has no LICENSE/MIT/license keyword
      writeFileSync(join(pkg, "README.md"), "# foo\n\nJust a package, no legal text here.\n")

      const result = await checkLicense(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/README.*missing reference.*foo/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})