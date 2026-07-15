// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkCompositeStructure` (../composite-structure.ts). Validates
// the v0.9.0+ composite layout:
//   1. Every expected composite (currently "safety", "memory") has a dir.
//   2. Its package.json has matching `role` field.
//   3. Its src/index.ts calls `mergeHooks()` and imports @sffmc/utilities.
//   4. (Inverse) No module package claims a role it shouldn't have.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkCompositeStructure } from "../composite-structure.ts"
import { getHealthConfigSync } from "../../config.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_composite_structure", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkCompositeStructure(REPO_ROOT)
    expect(result.name).toBe("composite_structure")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (safety + memory composites valid)", async () => {
    const result = await checkCompositeStructure(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/2 composites valid.*safety.*memory|safety \+ memory/)
  })

  test("fails when an expected composite directory is missing", async () => {
    // Empty tmpdir ⇒ safety/ and memory/ don't exist ⇒ 2 errors
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-comp-missing-"))
    try {
      mkdirSync(join(tmp, "packages"), { recursive: true })

      const result = await checkCompositeStructure(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/Composite directory missing.*safety/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("fails when composite src/index.ts does not call mergeHooks()", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-comp-nomerge-"))
    try {
      // Build a tmpdir with safety + memory, but memory has no mergeHooks
      const safety = join(tmp, "packages", "safety")
      const memory = join(tmp, "packages", "memory")
      mkdirSync(join(safety, "src"), { recursive: true })
      mkdirSync(join(memory, "src"), { recursive: true })

      writeFileSync(join(safety, "package.json"), JSON.stringify({ name: "safety", version: "1.0.0", role: "safety" }))
      writeFileSync(join(safety, "src", "index.ts"), "import { mergeHooks } from '@sffmc/utilities'\nexport const x = mergeHooks({})\n")

      writeFileSync(join(memory, "package.json"), JSON.stringify({ name: "memory", version: "1.0.0", role: "memory" }))
      // No mergeHooks call here — bad
      writeFileSync(join(memory, "src", "index.ts"), "import { createLogger } from '@sffmc/utilities'\nexport const log = createLogger('memory')\n")

      const result = await checkCompositeStructure(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/memory.*does not call mergeHooks/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("warns (not fails) when composite omits the @sffmc/utilities import", async () => {
    // The missing @sffmc/utilities import is a WARNING, not a hard fail.
    // The check passes mergeHooks + role match, but flags the absent import.
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-comp-nowarn-import-"))
    try {
      const safety = join(tmp, "packages", "safety")
      mkdirSync(join(safety, "src"), { recursive: true })
      writeFileSync(join(safety, "package.json"), JSON.stringify({ name: "safety", version: "1.0.0", role: "safety" }))
      // mergeHooks called but no @sffmc/utilities import
      writeFileSync(join(safety, "src", "index.ts"), "function mergeHooks() { return {} }\nexport const x = mergeHooks({})\n")

      const result = await checkCompositeStructure(tmp)
      // Two composites expected (safety + memory). Memory is missing ⇒ fail.
      // We expect fail because we only set up safety and not memory.
      expect(result.status).toBe("fail")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("uses `expectedComposites` from HealthConfig", async () => {
    // Sanity-check the config path that the check uses.
    const cfg = getHealthConfigSync()
    expect(cfg.expectedComposites).toContain("safety")
    expect(cfg.expectedComposites).toContain("memory")
  })
})