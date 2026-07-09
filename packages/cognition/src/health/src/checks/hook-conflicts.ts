// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 1: hook_conflicts — runs `scripts/audit-load-order.py` to
// regenerate `.sffmc/load-order-audit.json`, then parses the report
// to count real (non-safe-multi) hook conflicts between plugins.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { fileExists } from "../helpers.ts"
import { getHealthConfigSync } from "../config.ts"

export const checkHookConflicts = createCheck("hook_conflicts", async (repoRoot) => {
  const scriptPath = join(repoRoot, "scripts", "audit-load-order.py")
  const jsonPath = join(repoRoot, ".sffmc", "load-order-audit.json")
  const exists = await fileExists(scriptPath)
  if (!exists) {
    return {
      status: "fail",
      detail: `Audit script not found: ${scriptPath}`,
    }
  }

  try {
    // Run the audit script to regenerate the JSON report
    const proc = Bun.spawn(["python3", scriptPath], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited

    // Read the JSON report the script produces
    let report: { pkg_hooks?: Record<string, string[]>; all_hooks?: Record<string, string[]> }
    try {
      const jsonText = await readFile(jsonPath, "utf-8")
      report = JSON.parse(jsonText)
    } catch {
      return {
        status: "warn",
        detail: "Audit script ran but JSON report not found or unparseable",
      }
    }

    const allHooks = report.all_hooks || {}
    const pkgHooks = report.pkg_hooks || {}
    const pluginCount = Object.keys(pkgHooks).length

    // Most OpenCode hooks are designed for multiple plugins to chain/aggregate.
    // Only a few hooks are truly exclusive (where multiple registrations would conflict).
    // The known-safe hooks for multi-registration come from
    // `getHealthConfigSync().safeMultiHooks` (safeMultiHooks flag  release migration) — defaults
    // match the v0.14.x hardcoded list verbatim.
    const safeMultiHooks = new Set(getHealthConfigSync().safeMultiHooks)

    const realConflicts: string[] = []
    for (const [hook, pkgs] of Object.entries(allHooks)) {
      if (pkgs.length <= 1) continue
      if (safeMultiHooks.has(hook)) continue
      realConflicts.push(`${hook} (${pkgs.join(", ")})`)
    }

    if (realConflicts.length === 0) {
      return {
        status: "ok",
        detail: `${pluginCount}/${pluginCount} plugins, 0 real conflicts (${Object.keys(allHooks).length} hooks total, structural overlaps in safe-multi hooks are normal)`,
      }
    }

    return {
      status: "fail",
      detail: `${realConflicts.length} real hook conflict(s): ${realConflicts.join("; ")}`,
    }
  } catch (e) {
    return {
      status: "fail",
      detail: `Failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
})
