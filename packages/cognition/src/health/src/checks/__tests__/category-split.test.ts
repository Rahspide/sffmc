// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkCategorySplit` (../category-split.ts). Counts packages by
// the `category` field in their `package.json`. Expected distribution
// (v0.15.0+): msp + mimo-port + sffmc-original, no uncategorized. Any
// package missing the field lands in `uncategorized` ⇒ warn.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCategorySplit } from "../category-split.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_category_split", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkCategorySplit(REPO_ROOT)
    expect(result.name).toBe("category_split")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (no uncategorized packages)", async () => {
    const result = await checkCategorySplit(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/0 uncategorized/)
    // The repo has 2 msp (memory, safety) + 2 mimo-port (cognition, runtime)
    // + 1 sffmc-original (utilities) = 5 total.
    expect(result.detail).toMatch(/2 msp \+ 2 mimo-port \+ 1 sffmc-original/)
  })

  test("warns when a package is missing the category field", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-cat-uncat-"))
    try {
      const pkg = join(tmp, "packages", "undocumented")
      mkdirSync(pkg, { recursive: true })
      // package.json without `category` field
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "undocumented", version: "1.0.0" }))

      const result = await checkCategorySplit(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/1 uncategorized/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("counts known categories correctly in a custom tmpdir", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-cat-mixed-"))
    try {
      for (const [name, cat] of [
        ["a-msp", "msp"],
        ["b-msp", "msp"],
        ["c-port", "mimo-port"],
        ["d-orig", "sffmc-original"],
      ] as const) {
        const p = join(tmp, "packages", name)
        mkdirSync(p, { recursive: true })
        writeFileSync(join(p, "package.json"), JSON.stringify({ name, version: "1.0.0", category: cat }))
      }

      const result = await checkCategorySplit(tmp)
      expect(result.status).toBe("ok")
      // 2 msp + 1 mimo-port + 1 sffmc-original, 0 uncategorized
      expect(result.detail).toMatch(/2 msp \+ 1 mimo-port \+ 1 sffmc-original, 0 uncategorized/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("counts `shared` as uncategorized if present (shared is excluded from the loop)", async () => {
    // The check skips `pkg === "shared"` entirely (doesn't try to read its
    // package.json). So adding a shared/ directory should NOT bump the
    // uncategorized counter.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-cat-shared-"))
    try {
      const shared = join(tmp, "shared")
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, "package.json"), JSON.stringify({ name: "shared", version: "1.0.0" }))

      const result = await checkCategorySplit(tmp)
      expect(result.status).toBe("ok")
      expect(result.detail).toMatch(/0 uncategorized/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})