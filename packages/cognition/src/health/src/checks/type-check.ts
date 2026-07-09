// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 4: type_check — runs `bun build --target=bun --no-bundle
// src/index.ts` in each package directory and reports any failure.

import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { fileExists, packageNames, pkgDir } from "../helpers.ts"

export const checkTypeCheck = createCheck("type_check", async (repoRoot) => {
  const pkgs = await packageNames(repoRoot)
  const failures: string[] = []

  for (const pkg of pkgs) {
    const indexPath = join(pkgDir(pkg, repoRoot), "src", "index.ts")
    if (!(await fileExists(indexPath))) {
      failures.push(`${pkg} (no src/index.ts)`)
      continue
    }

    try {
      const proc = Bun.spawn(
        ["bun", "build", "--target=bun", "--no-bundle", "src/index.ts"],
        { cwd: pkgDir(pkg, repoRoot), stdout: "pipe", stderr: "pipe" },
      )
      const stderr = await new Response(proc.stderr).text()
      const exitCode = await proc.exited

      if (exitCode !== 0) {
        // Extract error lines (skip "bun build" header lines)
        const errors = stderr
          .split("\n")
          .filter((l) => l.trim() && !l.startsWith("bun build"))
          .join("\n")
          .trim()
        failures.push(`${pkg}: ${errors || `exit ${exitCode}`}`)
      }
    } catch (e) {
      failures.push(`${pkg}: spawn failed (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  if (failures.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages typecheck clean`,
    }
  }

  return {
    status: "fail",
    detail: `${failures.length} package(s) failed: ${failures.join("; ")}`,
  }
})
