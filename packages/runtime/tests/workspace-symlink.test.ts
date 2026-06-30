// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { tmpdir } from "node:os"
import {
  mkdtempSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs"
import path from "node:path"
import { WorkspaceJail } from "../src/workspace.ts"

// ── Setup ──────────────────────────────────────────────────────────────────
// One isolated workspace per test file. We create symlinks per-test and
// remove them in the test body to keep cases independent.

const ws = mkdtempSync(path.join(tmpdir(), "sffmc-workspace-symlink-"))
const jail = new WorkspaceJail(ws)

beforeAll(() => {
  // A subdir with a known file inside the workspace, used by the
  // "allows symlink within root" case.
  mkdirSync(path.join(ws, "subdir"), { recursive: true })
  writeFileSync(path.join(ws, "subdir", "file.txt"), "inside", "utf-8")
})

afterAll(() => {
  rmSync(ws, { recursive: true, force: true })
})

// ── Symlink-aware jail (symlink-aware jail) ────────────────────────

describe("WorkspaceJail: symlink-aware jail", () => {
  test("readFile blocks symlink to outside root", async () => {
    // ws/link → /etc (exists on every Unix). Reading link/passwd would
    // otherwise leak /etc/passwd to the caller.
    const linkPath = path.join(ws, "link")
    try {
      symlinkSync("/etc", linkPath)
    } catch {
      // Some sandboxes disallow symlink(2). Treat as a skip rather than a
      // hard failure so this suite can run in restricted environments.
      console.warn("[workspace-symlink] symlinkSync to /etc blocked; skipping")
      return
    }
    try {
      await expect(jail.readFile("link/passwd")).rejects.toThrow(
        /Jail escape via symlink/,
      )
    } finally {
      rmSync(linkPath, { force: true })
    }
  })

  test("readFile allows symlink within root", async () => {
    // ws/inner → ws/subdir (target stays inside root). The lexical path
    // resolves to a real path that is still under this.root, so it must
    // succeed.
    const linkPath = path.join(ws, "inner")
    try {
      symlinkSync(path.join(ws, "subdir"), linkPath)
    } catch {
      console.warn("[workspace-symlink] symlinkSync within root blocked; skipping")
      return
    }
    try {
      const content = await jail.readFile("inner/file.txt")
      expect(content).toBe("inside")
    } finally {
      rmSync(linkPath, { force: true })
    }
  })

  test("glob drops symlinked results outside root", async () => {
    // Use a controlled outside dir rather than /etc — the latter is huge
    // and would make the glob crawl very slow. The semantics under test
    // (drop results that resolve outside root) are identical.
    const outside = mkdtempSync(path.join(tmpdir(), "sffmc-symlink-outside-"))
    writeFileSync(path.join(outside, "secret.txt"), "x", "utf-8")
    const linkPath = path.join(ws, "etc-link")
    try {
      symlinkSync(outside, linkPath)
    } catch {
      console.warn("[workspace-symlink] symlinkSync to outside blocked; skipping")
      rmSync(outside, { recursive: true, force: true })
      return
    }
    try {
      const files = await jail.glob("**/*")
      // No etc-link contents should appear — every entry under it resolves
      // to the outside dir, which is not under this.root.
      for (const f of files) {
        expect(f.startsWith("etc-link")).toBe(false)
      }
      // Legitimate content inside the workspace is still listed.
      expect(files).toContain("subdir/file.txt")
    } finally {
      rmSync(linkPath, { force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})