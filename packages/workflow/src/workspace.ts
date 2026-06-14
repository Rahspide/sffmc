// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { resolve, relative, isAbsolute, dirname } from "node:path"
import { glob as globFs } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Lexical jail
// ---------------------------------------------------------------------------

let workspaceRoot: string | null = null

/** Set the workspace root for the lexical jail. All file operations are
 * confined to paths within this directory. */
export function setJail(workspacePath: string): void {
  workspaceRoot = resolve(workspacePath)
}

function getJail(): string {
  if (!workspaceRoot) throw new Error("Workspace jail not set — call setJail() first")
  return workspaceRoot
}

/**
 * Resolve a user-supplied path against the workspace root.
 * Throws if the resolved path escapes the root (lexical check only — does NOT
 * resolve symlinks).
 */
export function resolveInWorkspace(userPath: string): string {
  const root = getJail()
  const abs = resolve(root, userPath)
  // Lexical check: abs must start with root.
  // root === abs is allowed (userPath was "." or empty).
  if (!abs.startsWith(root + "/") && abs !== root) {
    throw new Error(`Jail escape: ${JSON.stringify(userPath)}`)
  }
  return abs
}

// ---------------------------------------------------------------------------
// File primitives
// ---------------------------------------------------------------------------

export async function readFile_(userPath: string): Promise<string | null> {
  const abs = resolveInWorkspace(userPath)
  try {
    return await readFile(abs, "utf-8")
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

export async function writeFile_(userPath: string, content: string): Promise<void> {
  const abs = resolveInWorkspace(userPath)
  await mkdir(dirname(abs), { recursive: true })
  await writeFile(abs, content, "utf-8")
}

export async function exists(userPath: string): Promise<boolean> {
  const abs = resolveInWorkspace(userPath)
  try {
    await access(abs)
    return true
  } catch {
    return false
  }
}

export async function glob(pattern: string): Promise<string[]> {
  const root = getJail()
  // Use node:fs/promises.glob with cwd set to root.
  // The result paths are relative to cwd.
  const matches: string[] = []
  for await (const entry of globFs(pattern, { cwd: root })) {
    // globFs returns paths relative to cwd (like "foo/bar" or "../outside")
    // Filter out escapes: any path starting with ".." or being absolute
    if (typeof entry === "string") {
      if (isAbsolute(entry)) continue
      if (entry.startsWith("..")) continue
      if (entry === "") continue
      matches.push(entry)
    }
  }
  return matches.sort()
}

// Re-export for Node 22+ glob compat. Use a wrapper to handle older versions.
// In Bun, glob is available from "node:fs/promises" since Bun 1.1+.
