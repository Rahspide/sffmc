// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { readFile, access } from "node:fs/promises"
import path from "node:path"
import { parseMeta, type Meta } from "./meta.ts"
import { ensureWorkflowConfig, getWorkflowSearchDirs } from "./constants.ts"

/** Raw filesystem existence check — NOT workspace-jailed.
 *  resolve.ts walks UP the directory tree and needs to check paths
 *  above the workspace root. */
async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/** Eagerly populate the workflow config cache at module-load time so
 *  `getWorkflowSearchDirs()` returns the YAML override (if any) on the
 *  first call to `resolveWorkflow()`. Failure is non-fatal: the sync
 *  getter falls back to `WORKFLOW_SEARCH_DIRS`. */
void ensureWorkflowConfig().catch(() => {
  // Best-effort — the sync getter's fallback handles the failure case.
})

const META_RE = /export\s+const\s+meta\s*=/

export function isInlineScript(nameOrScript: string): boolean {
  return META_RE.test(nameOrScript)
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/

export interface ResolvedWorkflow {
  source: string
  meta: Meta
  kind: "saved" | "inline" | "file"
}

/**
 * Resolve a workflow by name or file path.
 *
 * - "file": absolute path, or relative path resolved against workspace
 * - "inline": script text starts with `export const meta`
 * - "saved": name lookup under `.sffmc/workflows/` or `.claude/workflows/`
 */
export async function resolveWorkflow(
  nameOrPath: string,
  workspace: string,
): Promise<ResolvedWorkflow> {
  // Inline script
  if (isInlineScript(nameOrPath)) {
    const parsed = parseMeta(nameOrPath)
    if (!parsed.ok) {
      throw new Error(`Invalid inline workflow: ${parsed.error}`)
    }
    return { source: nameOrPath, meta: parsed.meta, kind: "inline" }
  }

  // Absolute or explicit relative path
  if (path.isAbsolute(nameOrPath) || nameOrPath.startsWith("./") || nameOrPath.startsWith("../")) {
    const resolved = path.isAbsolute(nameOrPath) ? nameOrPath : path.resolve(workspace, nameOrPath)
    // Jail check: resolved path must stay within workspace
    const normalizedResolved = path.resolve(resolved)
    const normalizedWorkspace = path.resolve(workspace)
    if (!normalizedResolved.startsWith(normalizedWorkspace + path.sep) && normalizedResolved !== normalizedWorkspace) {
      throw new Error(`Workflow path escapes workspace: ${JSON.stringify(nameOrPath)}`)
    }
    const source = await readFile(resolved, "utf-8")
    const parsed = parseMeta(source)
    if (!parsed.ok) {
      throw new Error(`Invalid workflow file ${resolved}: ${parsed.error}`)
    }
    return { source, meta: parsed.meta, kind: "file" }
  }

  // Saved workflow lookup
  if (!SAFE_NAME.test(nameOrPath)) {
    throw new Error(`invalid workflow name: ${JSON.stringify(nameOrPath)}`)
  }

  // initial release migration (W25): search dirs are now read from the
  // YAML-config (`WorkflowConfig.searchDirs`), defaulting to the prior
  // `[".sffmc/workflows", ".claude/workflows"]` array. The sync getter
  // returns the cached value or the default if `ensureWorkflowConfig()`
  // has not yet completed (best-effort — see top-of-file fire-and-forget).
  const subdirs = getWorkflowSearchDirs()
  let current = workspace
  for (;;) {
    for (const sub of subdirs) {
      const candidate = path.join(current, sub, `${nameOrPath}.ts`)
      if (await fileExists(candidate)) {
        const source = await readFile(candidate, "utf-8")
        const parsed = parseMeta(source)
        if (!parsed.ok) {
          throw new Error(`Invalid workflow ${candidate}: ${parsed.error}`)
        }
        return { source, meta: parsed.meta, kind: "saved" }
      }
    }
    // Walk up the directory tree
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  throw new Error(`Workflow not found: ${JSON.stringify(nameOrPath)}`)
}
