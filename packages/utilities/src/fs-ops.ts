// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

// Synchronous filesystem operations, abstracted behind an interface so
// tests can substitute an in-memory mock without touching real disk.
// Mirrors the sync subset of `node:fs` actually used across the SFFMC
// codebase (`packages/extra/src/checkpoint/*`, `packages/extra/src/dream.ts`,
// and the sync paths of `packages/workflow/src/persistence.ts`). Async fs
// ops in `workflow/workspace.ts` and the async paths of
// `workflow/persistence.ts` remain on `node:fs/promises` — those need a
// separate async refactor (constructor-injection through
// `WorkflowPersistence`).
//
// See the v0.15.0 implementation plan (file not in git; design choices summarized in CHANGELOG.md v0.15.0),
// Task 2.3.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"

/** Synchronous filesystem operations. All methods throw on filesystem
 *  errors (mirroring the underlying `node:fs` behavior) so callers can
 *  rely on the failure semantics they already expect from direct fs
 *  imports. The mock implementation throws the same way. */
export interface FsOps {
  /** Read a file as a UTF-8 string. */
  readFile: (path: string) => string
  /** Write a UTF-8 string to a file, replacing it if it exists. */
  writeFile: (path: string, content: string) => void
  /** Append a UTF-8 string to a file, creating it if necessary. */
  appendFile: (path: string, content: string) => void
  /** Test whether a file or directory exists at the given path. */
  exists: (path: string) => boolean
  /** Create a directory. `recursive: true` enables `mkdir -p` semantics. */
  mkdir: (path: string, opts?: { recursive?: boolean; mode?: number }) => void
  /** Read a directory's entries as file basenames. */
  readDir: (path: string) => string[]
  /** Stat a file. Returns `{ size, mtimeMs }` (subset of `Stats`). */
  stat: (path: string) => { size: number; mtimeMs: number }
  /** Remove a file. */
  unlink: (path: string) => void
  /** Copy a file. */
  copyFile: (src: string, dst: string) => void
}

/** Default `FsOps` implementation. Delegates straight to `node:fs` sync
 *  functions. Use in production; use `createMockFsOps()` for tests. */
export const defaultFsOps: FsOps = {
  readFile: (path) => readFileSync(path, "utf-8"),
  writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
  appendFile: (path, content) => appendFileSync(path, content, "utf-8"),
  exists: (path) => existsSync(path),
  mkdir: (path, opts) => mkdirSync(path, opts),
  readDir: (path) => readdirSync(path),
  stat: (path) => {
    const s = statSync(path)
    return { size: s.size, mtimeMs: s.mtimeMs }
  },
  unlink: (path) => unlinkSync(path),
  copyFile: (src, dst) => copyFileSync(src, dst),
}

/** Backing state of an in-memory `FsOps`. Pass to `createMockFsOps()` to
 *  pre-seed files / dirs. Returned alongside the mock so tests can inspect
 *  post-write state without going through the `FsOps` interface. */
export interface MockFsOpsState {
  files: Map<string, string>
  dirs: Set<string>
}

/** Build an in-memory `FsOps` backed by two collections: a `Map` of file
 *  paths to UTF-8 content, and a `Set` of registered directories. `exists`
 *  matches either kind. The mock throws `Error` with `.code = "ENOENT"`
 *  on missing reads / stats / unlinks, mirroring `node:fs` failure
 *  semantics so call sites that already catch can stay unchanged. */
export function createMockFsOps(
  state?: Partial<MockFsOpsState>,
): { fs: FsOps; files: Map<string, string>; dirs: Set<string> } {
  const files = state?.files ?? new Map<string, string>()
  const dirs = state?.dirs ?? new Set<string>()

  const enoent = (path: string): Error =>
    Object.assign(new Error(`ENOENT: no such file or directory '${path}'`), {
      code: "ENOENT",
    })

  const fs: FsOps = {
    readFile: (path) => {
      if (!files.has(path)) throw enoent(path)
      return files.get(path) ?? ""
    },
    writeFile: (path, content) => {
      files.set(path, content)
    },
    appendFile: (path, content) => {
      files.set(path, (files.get(path) ?? "") + content)
    },
    exists: (path) => files.has(path) || dirs.has(path),
    mkdir: (path, _opts) => {
      dirs.add(path)
    },
    readDir: (path) => {
      if (!dirs.has(path)) throw enoent(path)
      const prefix = path.endsWith("/") ? path : path + "/"
      const out: string[] = []
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) out.push(k.slice(prefix.length))
      }
      return out
    },
    stat: (path) => {
      if (files.has(path)) {
        return { size: (files.get(path) ?? "").length, mtimeMs: 0 }
      }
      throw enoent(path)
    },
    unlink: (path) => {
      if (!files.has(path)) throw enoent(path)
      files.delete(path)
    },
    copyFile: (src, dst) => {
      if (!files.has(src)) throw enoent(src)
      files.set(dst, files.get(src) ?? "")
    },
  }
  return { fs, files, dirs }
}
