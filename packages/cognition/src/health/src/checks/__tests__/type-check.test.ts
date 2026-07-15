// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkTypeCheck` (../type-check.ts). Runs `bun build
// --target=bun --no-bundle src/index.ts` in every package and reports any
// failure.
//
// NOTE: This check is the slowest in the suite (it spawns bun per package).
// The full real-repo run can take a few seconds. We deliberately avoid running
// it against the real SFFMC repo to keep unit-test latency low — instead we
// exercise it via tmpdir fixtures that make the per-package loop fast (no
// packages ⇒ empty loop ⇒ instant ok; one package ⇒ one bun spawn).

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkTypeCheck } from "../type-check.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_type_check", () => {
  test("returns CheckResult with correct name", async () => {
    // Empty tmpdir ⇒ packageNames() returns [] ⇒ loop has no iterations ⇒ ok
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-type-check-empty-"))
    try {
      const result = await checkTypeCheck(tmp)
      expect(result.name).toBe("type_check")
      expect(["ok", "warn", "fail"]).toContain(result.status)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok when no packages are present (empty repo)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-type-check-empty-"))
    try {
      const result = await checkTypeCheck(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/0\/0 packages typecheck clean/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("fails when a package has a TypeScript error", async () => {
    // Single package with broken src/index.ts → bun build will fail.
    // Note: `bun build --no-bundle` is a transpile pass, not a strict
    // type-check — it tolerates missing imports and type mismatches.
    // The reliable fail-signal is an actual syntax error
    // (unbalanced brace, trailing character, etc).
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-type-check-bad-"))
    try {
      const pkg = join(tmp, "packages", "broken-pkg")
      mkdirSync(join(pkg, "src"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "broken-pkg", version: "1.0.0" }))
      // Unbalanced paren → bun build parse error → non-zero exit
      writeFileSync(join(pkg, "src", "index.ts"), "const oops: number = (1 + 2")

      const result = await checkTypeCheck(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/broken-pkg/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("reports packages missing src/index.ts", async () => {
    // Package directory exists but has no src/index.ts
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-type-check-noindex-"))
    try {
      const pkg = join(tmp, "packages", "no-index-pkg")
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "no-index-pkg", version: "1.0.0" }))
      // No src/ subdir

      const result = await checkTypeCheck(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/no-index-pkg.*no src\/index\.ts/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("passes a clean package via bun build", async () => {
    // Single trivial package — `export const x = 1` typechecks clean.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-type-check-good-"))
    try {
      const pkg = join(tmp, "packages", "good-pkg")
      mkdirSync(join(pkg, "src"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "good-pkg", version: "1.0.0" }))
      writeFileSync(join(pkg, "src", "index.ts"), "export const greeting: string = 'hello'\n")

      const result = await checkTypeCheck(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/1\/1 packages typecheck clean/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})