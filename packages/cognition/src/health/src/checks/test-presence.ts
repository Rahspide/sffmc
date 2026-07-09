// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Check 2: test_presence — every test-owner package (composites + shared)
// must have at least one *.test.ts file in src/ or tests/.

import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCheck } from "../check-factory.ts"
import { packageNames, pkgDir } from "../helpers.ts"

export const checkTestPresence = createCheck("test_presence", async (repoRoot) => {
  // After  release (v0.9.0), module packages are "code-only" — their
  // tests live in the owning composite's test/ dir. Only check packages that
  // are themselves test owners: composites (have role) and shared (infra).
  const pkgs = await packageNames(repoRoot)
  const testOwners: string[] = []
  for (const pkg of pkgs) {
    if (pkg === "shared") {
      testOwners.push(pkg)
      continue
    }
    try {
      const content = await readFile(join(pkgDir(pkg, repoRoot), "package.json"), "utf-8")
      const parsed = JSON.parse(content) as { role?: string }
      if (parsed.role) testOwners.push(pkg)
    } catch {
      // package.json unreadable — skip
    }
  }

  const missing: string[] = []
  for (const pkg of testOwners) {
    let has = false
    for (const subdir of ["src", "tests"]) {
      try {
        const entries = await readdir(join(pkgDir(pkg, repoRoot), subdir))
        if (entries.some((e) => e.endsWith(".test.ts"))) {
          has = true
          break
        }
      } catch {
        // dir doesn't exist
      }
    }
    if (!has) missing.push(pkg)
  }

  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${testOwners.length}/${testOwners.length} test owners have tests (3 MSPs + shared)`,
    }
  }
  return {
    status: "fail",
    detail: `${missing.length} test owner(s) missing tests: ${missing.join(", ")}`,
  }
})
