// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkTsConfigPresence` (../tsconfig-presence.ts). Every package
// must have a parseable `tsconfig.json` (JSON-form). Missing ⇒ warn.
// Invalid JSON ⇒ fail (hard error, no recovering).

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkTsConfigPresence } from "../tsconfig-presence.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_tsconfig_presence", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkTsConfigPresence(REPO_ROOT)
    expect(result.name).toBe("tsconfig_presence")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (every package has tsconfig.json)", async () => {
    const result = await checkTsConfigPresence(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/tsconfig\.json/)
  })

  test("warns when a package is missing tsconfig.json", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-tsconfig-missing-"))
    try {
      const pkg = join(tmp, "packages", "no-tsconfig")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "no-tsconfig", version: "1.0.0" }))
      // No tsconfig.json

      const result = await checkTsConfigPresence(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/missing tsconfig\.json.*no-tsconfig/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("fails when a tsconfig.json is unparseable", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-tsconfig-broken-"))
    try {
      const pkg = join(tmp, "packages", "bad-tsconfig")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "bad-tsconfig", version: "1.0.0" }))
      // Invalid JSON (unbalanced braces, trailing comma)
      writeFileSync(join(pkg, "tsconfig.json"), "{ \"compilerOptions\": { \"target\": \"esnext\",, } }")

      const result = await checkTsConfigPresence(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/invalid tsconfig\.json.*bad-tsconfig/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok when every package has a valid tsconfig.json", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-tsconfig-good-"))
    try {
      const pkg = join(tmp, "packages", "well-configured")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "well-configured", version: "1.0.0" }))
      writeFileSync(join(pkg, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "esnext" } }))

      const result = await checkTsConfigPresence(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/1\/1 packages have tsconfig\.json/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})