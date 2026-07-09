// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 9: tsconfig_presence — every package has a valid tsconfig.json.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { packageNames, pkgDir } from "../helpers.ts"

export const checkTsConfigPresence = createCheck("tsconfig_presence", async (repoRoot) => {
  const pkgs = await packageNames(repoRoot)
  const missing: string[] = []
  const invalidJson: string[] = []

  for (const pkg of pkgs) {
    const tsconfigPath = join(pkgDir(pkg, repoRoot), "tsconfig.json")
    try {
      const content = await readFile(tsconfigPath, "utf-8")
      try {
        JSON.parse(content)
      } catch {
        invalidJson.push(pkg)
      }
    } catch {
      missing.push(pkg)
    }
  }

  if (invalidJson.length > 0) {
    return {
      status: "fail",
      detail: `${invalidJson.length} package(s) have invalid tsconfig.json: ${invalidJson.join(", ")}`,
    }
  }

  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have tsconfig.json`,
    }
  }

  return {
    status: "warn",
    detail: `${missing.length} package(s) missing tsconfig.json: ${missing.join(", ")}`,
  }
})
