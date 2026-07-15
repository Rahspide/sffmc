// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkSdkCompliance` (../sdk-compliance.ts). Every package's
// `src/index.ts` should import from `@sffmc/utilities`, import from a
// local `../shared/src/`, or carry an explicit `@sffmc-shared: excluded`
// exclusion comment. Known exceptions: `max-mode`, `workflow`, `utilities`.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkSdkCompliance } from "../sdk-compliance.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_sdk_compliance", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkSdkCompliance(REPO_ROOT)
    expect(result.name).toBe("sdk_compliance")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (every package imports utilities)", async () => {
    const result = await checkSdkCompliance(REPO_ROOT)
    expect(result.status).toBe("ok")
    // detail mentions known exceptions list (utilities is the base library)
    expect(result.detail).toMatch(/known exceptions/)
  })

  test("fails when a package is missing src/index.ts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-sdk-noindex-"))
    try {
      mkdirSync(join(tmp, "packages", "ghost"), { recursive: true })
      // No src/index.ts at all — readFile throws → missingDir

      const result = await checkSdkCompliance(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/missing src\/index\.ts.*ghost/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("warns when src/index.ts lacks the @sffmc/utilities import", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-sdk-noimport-"))
    try {
      const pkg = join(tmp, "packages", "standalone")
      mkdirSync(join(pkg, "src"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "standalone", version: "1.0.0" }))
      // No @sffmc/utilities import, no exclusion comment
      writeFileSync(join(pkg, "src", "index.ts"), "export const greeting = 'hi'\n")

      const result = await checkSdkCompliance(tmp)
      expect(result.status).toBe("warn")
      expect(result.detail).toMatch(/missing @sffmc\/utilities import.*standalone/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("returns ok for a package whose index.ts imports @sffmc/utilities", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-sdk-good-"))
    try {
      const pkg = join(tmp, "packages", "wellbehaved")
      mkdirSync(join(pkg, "src"), { recursive: true })
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "wellbehaved", version: "1.0.0" }))
      writeFileSync(join(pkg, "src", "index.ts"), "import { createLogger } from '@sffmc/utilities'\nexport const log = createLogger('x')\n")

      const result = await checkSdkCompliance(tmp)
      expect(result.status).toBe("ok")
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})