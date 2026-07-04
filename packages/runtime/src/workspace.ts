// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import {
  readFile,
  writeFile,
  mkdir,
  access,
  open,
  constants as fsConstants,
} from "node:fs/promises"
import { realpathSync } from "node:fs"
import { resolve, relative, isAbsolute, dirname } from "node:path"
import { glob as globFs } from "node:fs/promises"

/** POSIX `O_NOFOLLOW` flag (Linux/macOS). Refuses to follow a symlink at the
 *  leaf of the path. Set to a sentinel value on platforms where it doesn't
 *  exist (Windows). Used as defense-in-depth on the open call — see the
 *  SECURITY NOTE in the `WorkspaceJail` class body. */
const O_NOFOLLOW: number =
  typeof fsConstants.O_NOFOLLOW === "number"
    ? fsConstants.O_NOFOLLOW
    : 0

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
   *
   * Two-stage check:
   *   1. Lexical — the resolved path must start with `this.root` (or equal it).
   *   2. Symlink-aware — `realpathSync` follows every symlink in the path and
   *      the final target must still be within `this.root`.
   *
   * For paths that don't exist yet (e.g. `writeFile` to a new file, or
   * `exists()` on a missing file), we walk up to the nearest existing
   * ancestor and verify that ancestor's real path stays in root; we then
   * return the real path built from that ancestor plus the remaining
   * unresolvable tail. This lets writes create new files without false
   * positives while still rejecting symlink escapes for write targets.
   *
   * Throws on:
   *   - Lexical escape ("Jail escape: ...")
   *   - Symlink escape ("Jail escape via symlink: ...")
   */
  resolveInWorkspace(userPath: string): string {
    const abs = resolve(this.root, userPath)
    // Lexical check: abs must start with root.
    // root === abs is allowed (userPath was "." or empty).
    if (!abs.startsWith(this.root + "/") && abs !== this.root) {
      throw new Error(`Jail escape: ${JSON.stringify(userPath)}`)
    }
    // Root itself is always safe; no symlinks to follow on the jail anchor.
    if (abs === this.root) {
      return abs
    }
    // Walk from `abs` toward root, realpath-resolving the first component
    // that actually exists. If it escapes, throw. Otherwise reconstruct
    // the full real path.
    let current: string = abs
    while (true) {
      let real: string
      try {
        real = realpathSync(current)
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e
        }
        const parent = dirname(current)
        if (parent === current) {
          // Reached filesystem root without finding any existing component.
          // The lexical check should have caught a path outside this.root,
          // so this is a degenerate case (e.g. this.root doesn't exist).
          throw new Error(
            `Cannot resolve path: ${JSON.stringify(userPath)}`,
          )
        }
        current = parent
        continue
      }
      // Resolved — verify it stays within the jail.
      if (!real.startsWith(this.root + "/") && real !== this.root) {
        throw new Error(
          `Jail escape via symlink: ${JSON.stringify(userPath)}`,
        )
      }
      // If we resolved `abs` itself, return its real path.
      // Otherwise we resolved an ancestor — build the full real path by
      // appending the remaining tail from abs.
      if (current === abs) {
        return real
      }
      const tail = relative(current, abs)
      return resolve(real, tail)
    }
  }

  // ── File primitives ────────────────────────────────────────────────────
  // SECURITY NOTE: TOCTOU window between `resolveInWorkspace()` (symlink
  // check) and the actual I/O operation. The leaf component (the target
  // file itself) is closed by `O_NOFOLLOW` below on platforms that expose
  // it (Linux/macOS) — a symlink swap at the leaf fails at open() time
  // with ELOOP. Component-level swaps (a parent directory replaced with
  // a symlink between check and use) still require either root-level
  // kernel mount privileges or same-user write access during the open
  // window, and are out of scope for the portable fix. For high-security
  // environments, avoid symlinks in the workspace root.

  /** Internal: read a file via `open(O_RDONLY | O_NOFOLLOW)` so a symlink
   *  swap at the leaf fails at open time (ELOOP) instead of resolving
   *  after our realpath check completed. */
  private async safeRead(abs: string): Promise<string> {
    if (O_NOFOLLOW) {
      const handle = await open(abs, fsConstants.O_RDONLY | O_NOFOLLOW)
      try {
        const buf = Buffer.alloc(handle.statSync ? -1 : 0) // unused
        const fh = await handle.readFile({ encoding: "utf-8" })
        return fh as string
      } finally {
        await handle.close()
      }
    }
    return readFile(abs, "utf-8")
  }

  /** Internal: write a file via `open(O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW)`
   *  so a symlink swap at the leaf fails at open time. */
  private async safeWrite(abs: string, content: string): Promise<void> {
    if (O_NOFOLLOW) {
      const handle = await open(
        abs,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW,
        0o644,
      )
      try {
        await handle.writeFile(content, "utf-8")
      } finally {
        await handle.close()
      }
      return
    }
    await writeFile(abs, content, "utf-8")
  }

  async readFile(userPath: string): Promise<string | null> {
    const abs = this.resolveInWorkspace(userPath)
    try {
      return await this.safeRead(abs)
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  }

  async writeFile(userPath: string, content: string): Promise<void> {
    const abs = this.resolveInWorkspace(userPath)
    await mkdir(dirname(abs), { recursive: true })
    await this.safeWrite(abs, content)
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
    // Pattern sanitization — reject patterns that, after `path.resolve`
    // normalization, escape the workspace. node:fs/promises.glob treats
    // `..` segments as path components (not glob meta-chars), so a pattern
    // like `../etc/*` would otherwise surface matches the per-entry filter
    // would silently drop. Fail loud at the boundary instead.
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error(`WorkspaceJail.glob: pattern must be non-empty string`)
    }
    const normalizedRoot = resolve(this.root)
    const resolvedPattern = resolve(normalizedRoot, pattern)
    if (
      resolvedPattern !== normalizedRoot &&
      !resolvedPattern.startsWith(normalizedRoot + "/")
    ) {
      throw new Error(
        `WorkspaceJail.glob: pattern escapes workspace: ${JSON.stringify(pattern)}`,
      )
    }

    const matches: string[] = []
    for await (const entry of globFs(pattern, { cwd: this.root })) {
      // globFs returns paths relative to cwd (like "foo/bar" or "../outside")
      // Filter out escapes: any path starting with ".." or being absolute.
      if (typeof entry === "string") {
        if (isAbsolute(entry)) continue
        if (entry.startsWith("..")) continue
        if (entry === "") continue
        // Symlink-aware filter: realpath-resolve and verify it stays in root.
        // Broken symlinks / unreadable paths are dropped (cannot verify).
        const abs = resolve(this.root, entry)
        let real: string
        try {
          real = realpathSync(abs)
        } catch {
          continue
        }
        if (
          !real.startsWith(this.root + "/") &&
          real !== this.root
        ) {
          continue
        }
        matches.push(entry)
      }
    }
    return matches.sort()
  }
}