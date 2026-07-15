// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

// Shared helpers for the 13 health checks in this package.
// Imported by each individual check in `checks/`.

import { readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createLogger } from "@sffmc/utilities"
import type { CheckOutcome } from "./check-factory.ts"

const log = createLogger("cognition:health-helpers")

/** `process.env.HOME` override or `os.homedir()`. Tests can stub by setting `HOME`. */
export function userHome(): string {
  return process.env.HOME || homedir()
}

/** List all package directory names under `packages/` (and `shared/` if it has a `package.json`).
 *  Used by per-package checks (test_presence, readme_presence, etc). */
export async function packageNames(repoRoot: string): Promise<string[]> {
  const pkgs: string[] = []
  try {
    const entries = await readdir(join(repoRoot, "packages"), { withFileTypes: true })
    pkgs.push(...entries.filter((e) => e.isDirectory()).map((e) => e.name))
  } catch (e) {
    log.debug({ err: e, repoRoot }, "health-helpers: packages/ readdir failed (treating as empty)")
    // packages/ doesn't exist — no packages to check
  }
  // Include shared if it has a package.json
  try {
    await stat(join(repoRoot, "shared", "package.json"))
    pkgs.push("shared")
  } catch (e) {
    log.debug({ err: e, repoRoot }, "health-helpers: shared/package.json stat failed (skipping)")
    // shared doesn't exist — skip
  }
  return pkgs.sort()
}

/** `packages/<pkg>` for normal packages, or `shared/` for the shared one. */
export function pkgDir(pkg: string, repoRoot: string): string {
  return pkg === "shared" ? join(repoRoot, "shared") : join(repoRoot, "packages", pkg)
}

/** Run a per-package presence check across all packages (including shared).
 *  Returns ok if every package passes the test, fail otherwise. */
export async function checkPerPackage(
  repoRoot: string,
  noun: string,
  test: (pkgDir: string) => Promise<boolean>,
): Promise<CheckOutcome> {
  const pkgs = await packageNames(repoRoot)
  const missing: string[] = []
  for (const pkg of pkgs) {
    if (!(await test(pkgDir(pkg, repoRoot)))) {
      missing.push(pkg)
    }
  }
  if (missing.length === 0) {
    return {
      status: "ok",
      detail: `${pkgs.length}/${pkgs.length} packages have ${noun}`,
    }
  }
  return {
    status: "fail",
    detail: `${missing.length} package(s) missing ${noun}: ${missing.join(", ")}`,
  }
}

/** `fs.access`-like check, but uses `stat` (also covers dirs). */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (e) {
    log.debug({ err: e, path }, "health-helpers: fileExists stat failed (returning false)")
    return false
  }
}
