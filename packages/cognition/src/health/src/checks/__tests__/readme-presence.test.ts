// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkReadmePresence` (../readme-presence.ts). Every package
// (composites + modules + shared) must have a README.md.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReadmePresence } from "../readme-presence.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_readme_presence", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkReadmePresence(REPO_ROOT)
    expect(result.name).toBe("readme_presence")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo", async () => {
    const result = await checkReadmePresence(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/README\.md/)
  })

  test("fails when a package is missing README.md", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-readme-presence-"))
    try {
      const pkg = join(tmp, "packages", "no-readme-pkg")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "no-readme-pkg", version: "1.0.0" }))
      // no README.md

      const result = await checkReadmePresence(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/missing README\.md.*no-readme-pkg/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok when every package has a README.md", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-readme-presence-"))
    try {
      const pkg = join(tmp, "packages", "good-pkg")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "good-pkg", version: "1.0.0" }))
      writeFileSync(join(pkg, "README.md"), "# good-pkg")

      const result = await checkReadmePresence(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/1\/1 packages have README\.md/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})