// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 6: version_consistency — every package's package.json version
// must match the root version.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { packageNames, pkgDir } from "../helpers.ts"

export const checkVersionConsistency = createCheck("version_consistency", async (repoRoot) => {
  // Read root version
  let rootVersion: string
  try {
    const rootPkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf-8"))
    rootVersion = rootPkg.version || "unknown"
  } catch {
    return {
      status: "fail",
      detail: "Could not read root package.json",
    }
  }

  const pkgs = await packageNames(repoRoot)
  const mismatches: string[] = []

  for (const pkg of pkgs) {
    try {
      const pkgJson = JSON.parse(await readFile(join(pkgDir(pkg, repoRoot), "package.json"), "utf-8"))
      const ver = pkgJson.version
      if (ver !== rootVersion) {
        mismatches.push(`${pkg}: ${ver} (root: ${rootVersion})`)
      }
    } catch {
      mismatches.push(`${pkg}: could not read package.json`)
    }
  }

  if (mismatches.length === 0) {
    return {
      status: "ok",
      detail: `All ${pkgs.length} packages match root version ${rootVersion}`,
    }
  }

  return {
    status: "warn",
    detail: `Root ${rootVersion}, ${mismatches.length} mismatches: ${mismatches.join(", ")}`,
  }
})
