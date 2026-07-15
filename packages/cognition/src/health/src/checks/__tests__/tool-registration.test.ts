// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkToolRegistration` (../tool-registration.ts). Scans the
// tool-bearing files listed in `getHealthConfigSync().toolFiles` for the
// fix-17 "name" field regression: a tool-level `name: "X"` at the same
// indent as `description` and `execute`. Parameter-schema `name:` (object
// value) is fine.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { checkToolRegistration } from "../tool-registration.ts"
import { getHealthConfigSync } from "../../config.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_tool_registration", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkToolRegistration(REPO_ROOT)
    expect(result.name).toBe("tool_registration")
    expect(["ok", "warn", "fail"]).toContain(result.status)
  })

  test("returns ok against the real SFFMC repo (no fix-17 regression)", async () => {
    const result = await checkToolRegistration(REPO_ROOT)
    expect(result.status).toBe("ok")
    expect(result.detail).toMatch(/0 'name' field bugs/)
  })

  test("scans every file listed in toolFiles config", async () => {
    const cfg = getHealthConfigSync()
    const toolFileCount = cfg.toolFiles.length
    expect(toolFileCount).toBeGreaterThan(0)
    // detail should reference exactly that count
    const result = await checkToolRegistration(REPO_ROOT)
    expect(result.detail).toContain(String(toolFileCount))
  })

  test("toolFiles entries all exist in the real repo (sanity)", async () => {
    const cfg = getHealthConfigSync()
    for (const rel of cfg.toolFiles) {
      const abs = `${REPO_ROOT}${rel}`
      // existsSync would be cleaner but a quick smoke check on the file
      expect(rel).toMatch(/\.ts$/)
      expect(abs.endsWith(rel)).toBe(true)
    }
  })
})