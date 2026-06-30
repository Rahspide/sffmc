// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { tmpdir } from "os"

import { defaultFsOps, createMockFsOps, type FsOps } from "./fs-ops.ts"

// ---------------------------------------------------------------------------
// Real-disk tests for `defaultFsOps`. Each test uses a unique temp directory
// so they don't race or share state.
// ---------------------------------------------------------------------------

describe("defaultFsOps", () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(resolve(tmpdir(), "sffmc-fsops-test-"))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it("writes and reads back a string", () => {
    const fp = resolve(tmp, "hello.txt")
    defaultFsOps.writeFile(fp, "hi")
    expect(defaultFsOps.readFile(fp)).toBe("hi")
  })

  it("appendFile concatenates", () => {
    const fp = resolve(tmp, "log.txt")
    defaultFsOps.appendFile(fp, "line1\n")
    defaultFsOps.appendFile(fp, "line2\n")
    expect(defaultFsOps.readFile(fp)).toBe("line1\nline2\n")
  })

  it("exists returns true for present files and false for absent", () => {
    const fp = resolve(tmp, "present.txt")
    defaultFsOps.writeFile(fp, "x")
    expect(defaultFsOps.exists(fp)).toBe(true)
    expect(defaultFsOps.exists(resolve(tmp, "absent.txt"))).toBe(false)
  })

  it("mkdir creates the directory", () => {
    const d = resolve(tmp, "nested", "deeper")
    defaultFsOps.mkdir(d, { recursive: true })
    expect(existsSync(d)).toBe(true)
  })

  it("readDir lists entries", () => {
    defaultFsOps.writeFile(resolve(tmp, "a"), "a")
    defaultFsOps.writeFile(resolve(tmp, "b"), "b")
    const entries = defaultFsOps.readDir(tmp)
    expect(entries.sort()).toEqual(["a", "b"])
  })

  it("stat reports size in bytes", () => {
    const fp = resolve(tmp, "size.txt")
    defaultFsOps.writeFile(fp, "abcde")
    expect(defaultFsOps.stat(fp).size).toBe(5)
  })

  it("unlink removes a file", () => {
    const fp = resolve(tmp, "kill.txt")
    defaultFsOps.writeFile(fp, "x")
    defaultFsOps.unlink(fp)
    expect(defaultFsOps.exists(fp)).toBe(false)
  })

  it("matches what consumer code expects: round-trip via the real fs", () => {
    const fp = resolve(tmp, "rt.txt")
    defaultFsOps.writeFile(fp, "round-trip")
    // Verify via raw node:fs to confirm we're not isolated from the real disk.
    expect(readFileSync(fp, "utf-8")).toBe("round-trip")
  })
})

// ---------------------------------------------------------------------------
// In-memory tests for `createMockFsOps()`. The factory exposes the backing
// `files` and `dirs` maps so tests can seed inputs and inspect writes.
// ---------------------------------------------------------------------------

describe("createMockFsOps", () => {
  it("seeds and reads back a string", () => {
    const { fs } = createMockFsOps()
    fs.writeFile("/seed.txt", "hello")
    expect(fs.readFile("/seed.txt")).toBe("hello")
  })

  it("throws ENOENT on missing file read", () => {
    const { fs } = createMockFsOps()
    expect(() => fs.readFile("/missing")).toThrow()
  })

  it("appendFile concatenates", () => {
    const { fs } = createMockFsOps()
    fs.appendFile("/a", "x")
    fs.appendFile("/a", "y")
    expect(fs.readFile("/a")).toBe("xy")
  })

  it("exists returns true only for known paths", () => {
    const { fs } = createMockFsOps()
    fs.mkdir("/d", { recursive: true })
    fs.writeFile("/d/f", "z")
    expect(fs.exists("/d/f")).toBe(true)
    expect(fs.exists("/d")).toBe(true)
    expect(fs.exists("/missing")).toBe(false)
  })

  it("mkdir registers the directory", () => {
    const { fs } = createMockFsOps()
    fs.mkdir("/some/dir", { recursive: true })
    expect(fs.exists("/some/dir")).toBe(true)
  })

  it("readDir returns file basenames under the dir", () => {
    const { fs, dirs } = createMockFsOps()
    dirs.add("/dir")
    fs.writeFile("/dir/a.txt", "1")
    fs.writeFile("/dir/b.txt", "2")
    expect(fs.readDir("/dir").sort()).toEqual(["a.txt", "b.txt"])
  })

  it("stat reports the content length for a file", () => {
    const { fs } = createMockFsOps()
    fs.writeFile("/s", "12345")
    expect(fs.stat("/s").size).toBe(5)
  })

  it("stat throws on missing file", () => {
    const { fs } = createMockFsOps()
    expect(() => fs.stat("/nope")).toThrow()
  })

  it("unlink removes from the file map", () => {
    const { fs, files } = createMockFsOps()
    fs.writeFile("/u", "x")
    fs.unlink("/u")
    expect(files.has("/u")).toBe(false)
  })

  it("copyFile duplicates the file under a new path", () => {
    const { fs } = createMockFsOps()
    fs.writeFile("/src", "body")
    fs.copyFile("/src", "/dst")
    expect(fs.readFile("/dst")).toBe("body")
  })
})

// ---------------------------------------------------------------------------
// interface conformance — both implementations must satisfy FsOps.
// ---------------------------------------------------------------------------

describe("FsOps conformance", () => {
  it("defaultFsOps satisfies FsOps", () => {
    const ops: FsOps = defaultFsOps
    expect(typeof ops.readFile).toBe("function")
    expect(typeof ops.writeFile).toBe("function")
  })

  it("createMockFsOps().fs satisfies FsOps", () => {
    const { fs } = createMockFsOps()
    const ops: FsOps = fs
    expect(typeof ops.readFile).toBe("function")
    expect(typeof ops.writeFile).toBe("function")
  })
})
