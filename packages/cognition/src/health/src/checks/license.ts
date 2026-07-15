// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 7: license — root LICENSE file exists, and every package
// README references it (or "MIT"/"license" keyword).

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { createLogger } from "@sffmc/utilities"
import { createCheck } from "../check-factory.ts"
import { fileExists, packageNames, pkgDir } from "../helpers.ts"

const log = createLogger("health:license")

export const checkLicense = createCheck("license", async (repoRoot) => {
  const licenseExists = await fileExists(join(repoRoot, "LICENSE"))
  const missingRefs: string[] = []

  // Check each package README references LICENSE or MIT
  const pkgs = await packageNames(repoRoot)
  for (const pkg of pkgs) {
    const readmePath = join(pkgDir(pkg, repoRoot), "README.md")
    if (!(await fileExists(readmePath))) {
      missingRefs.push(`${pkg} (no README)`)
      continue
    }
    try {
      const content = await readFile(readmePath, "utf-8")
      if (!/(LICENSE|MIT|license)/i.test(content)) {
        missingRefs.push(pkg)
      }
    } catch (e) {
      log.debug({ err: e, pkg, readmePath }, "license: README.md read failed")
      missingRefs.push(`${pkg} (read error)`)
    }
  }

  if (!licenseExists) {
    return {
      status: "fail",
      detail: "No LICENSE file in repo root",
    }
  }

  if (missingRefs.length === 0) {
    return {
      status: "ok",
      detail: `LICENSE present, all ${pkgs.length} READMEs reference it`,
    }
  }

  return {
    status: "warn",
    detail: `LICENSE present, ${missingRefs.length} README(s) missing reference: ${missingRefs.join(", ")}`,
  }
})
