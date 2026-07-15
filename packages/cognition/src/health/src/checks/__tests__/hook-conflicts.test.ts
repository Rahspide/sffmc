// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../../../LICENSE
//
// Tests for `checkHookConflicts` (../hook-conflicts.ts). This check runs
// `scripts/audit-load-order.py` to regenerate `.sffmc/load-order-audit.json`
// and reports any hook key registered by 2+ plugins that is NOT in the
// `safeMultiHooks` whitelist.

import { describe, test, expect } from "bun:test"
import { resolve } from "node:path"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkHookConflicts } from "../hook-conflicts.ts"

const REPO_ROOT = resolve(import.meta.dir, "../../../../../../../")

describe("check_hook_conflicts", () => {
  test("returns CheckResult with correct name", async () => {
    const result = await checkHookConflicts(REPO_ROOT)
    expect(result.name).toBe("hook_conflicts")
    expect(["ok", "warn", "fail"]).toContain(result.status)
    expect(typeof result.detail).toBe("string")
  })

  test("returns ok against the real SFFMC repo (no real conflicts)", async () => {
    const result = await checkHookConflicts(REPO_ROOT)
    expect(result.status).toBe("ok")
    // detail mentions plugin count + 0 conflicts
    expect(result.detail).toMatch(/0 real conflicts/)
  })

  test("fails when audit script is missing", async () => {
    // Tmpdir has no scripts/audit-load-order.py — check returns fail
    const tmp = mkdtempSync(join(tmpdir(), "sffmc-hook-conflicts-"))
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true })
      mkdirSync(join(tmp, ".sffmc"), { recursive: true })
      // Note: no audit-load-order.py

      const result = await checkHookConflicts(tmp)
      expect(result.status).toBe("fail")
      expect(result.detail).toMatch(/Audit script not found/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("produces a non-empty detail string", async () => {
    const result = await checkHookConflicts(REPO_ROOT)
    expect(result.detail.length).toBeGreaterThan(10)
  })
})
