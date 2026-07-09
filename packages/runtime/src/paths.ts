// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Path helpers, extracted from persistence.ts per the v0.16.0 refactor
// plan (ora-9, Phase 4). The data dir resolution (XDG override + fallback
// to ~/.local/share) and the db-path-from-dir helper live here; the
// WorkflowPersistence class delegates to `defaultDataDir()` and
// `dbPathForDir()`.

import path from "node:path"
import { homedir } from "node:os"
import { ensureWorkflowConfig, getDbFilename, getWorkflowDataDir } from "./constants.ts"

export function defaultDataDir(): string {
  const override = getWorkflowDataDir()
  if (override && override.trim().length > 0) return override
  const xdg = process.env.XDG_DATA_HOME
  if (xdg) return path.join(xdg, "SFFMC", "workflow")
  return path.join(homedir(), ".local", "share", "SFFMC", "workflow")
}

/** Eagerly populate the workflow config cache at module-load time so
 *  `getWorkflowDataDir()` returns the YAML override (if any) on the
 *   call to `defaultDataDir()`. Failure is non-fatal: the sync
 *  getter falls back to the hardcoded XDG default. */
export function eagerlyPopulateWorkflowConfig(): void {
  void ensureWorkflowConfig().catch(() => {
    // Best-effort — the sync getter's fallback handles the failure case.
  })
}

export function dbPathForDir(dir: string): string {
  return path.join(dir, getDbFilename())
}
