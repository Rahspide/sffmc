// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 8: sdk_compliance — every package's `src/index.ts` should import
// from `@sffmc/utilities` (or have an explicit exclusion comment).
// `max-mode` and `workflow` are the two known exceptions.

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { packageNames } from "../helpers.ts"

const KNOWN_SDK_EXCEPTIONS = new Set(["max-mode", "workflow"])

export const checkSdkCompliance = createCheck("sdk_compliance", async (repoRoot) => {
  const pkgs = (await packageNames(repoRoot)).filter((p) => p !== "shared")
  const missingImport: string[] = []
  const missingDir: string[] = []

  for (const pkg of pkgs) {
    if (KNOWN_SDK_EXCEPTIONS.has(pkg)) continue

    const indexPath = join(repoRoot, "packages", pkg, "src", "index.ts")
    try {
      const content = await readFile(indexPath, "utf-8")
      const hasSharedImport = /from\s+["']@sffmc\/utilities["']/.test(content)
        || /from\s+["']\.\.\/shared\/src\//.test(content)
      const hasExclusionComment = /\/\/\s*@sffmc-shared:\s*excluded/.test(content)
      if (!hasSharedImport && !hasExclusionComment) {
        missingImport.push(pkg)
      }
    } catch {
      missingDir.push(pkg)
    }
  }

  if (missingDir.length > 0) {
    return {
      status: "fail",
      detail: `${missingDir.length} package(s) missing src/index.ts: ${missingDir.join(", ")}`,
    }
  }

  if (missingImport.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length - KNOWN_SDK_EXCEPTIONS.size}/${pkgs.length} packages import @sffmc/utilities (2 known exceptions: ${[...KNOWN_SDK_EXCEPTIONS].join(", ")})`,
    }
  }

  return {
    status: "warn",
    detail: `${missingImport.length} package(s) missing @sffmc/utilities import: ${missingImport.join(", ")}`,
  }
})
