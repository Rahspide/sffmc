// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { readFile, writeFile, mkdir, access } from "node:fs/promises"
import { resolve, relative, isAbsolute, dirname } from "node:path"
import { glob as globFs } from "node:fs/promises"

// ---------------------------------------------------------------------------
// Lexical jail — class-based, no module-level state
// ---------------------------------------------------------------------------

export class WorkspaceJail {
  private root: string

  /** Set the workspace root for the lexical jail. All file operations are
   *  confined to paths within this directory. */
  constructor(workspacePath: string) {
    this.root = resolve(workspacePath)
  }

  /**
   * Resolve a user-supplied path against the workspace root.
   * Throws if the resolved path escapes the root (lexical check only — does NOT
   * resolve symlinks).
   */
  resolveInWorkspace(userPath: string): string {
    const abs = resolve(this.root, userPath)
    // Lexical check: abs must start with root.
    // root === abs is allowed (userPath was "." or empty).
    if (!abs.startsWith(this.root + "/") && abs !== this.root) {
      throw new Error(`Jail escape: ${JSON.stringify(userPath)}`)
    }
    return abs
  }

  // ── File primitives ────────────────────────────────────────────────────

  async readFile(userPath: string): Promise<string | null> {
    const abs = this.resolveInWorkspace(userPath)
    try {
      return await readFile(abs, "utf-8")
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  }

  async writeFile(userPath: string, content: string): Promise<void> {
    const abs = this.resolveInWorkspace(userPath)
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, content, "utf-8")
  }

  async exists(userPath: string): Promise<boolean> {
    const abs = this.resolveInWorkspace(userPath)
    try {
      await access(abs)
      return true
    } catch {
      return false
    }
  }

  async glob(pattern: string): Promise<string[]> {
    // Use node:fs/promises.glob with cwd set to root.
    const matches: string[] = []
    for await (const entry of globFs(pattern, { cwd: this.root })) {
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
}
