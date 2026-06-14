// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { loadConfig } from "./config.ts"
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs"
import { resolve } from "path"
import { tmpdir } from "os"

const TEST_HOME = resolve(tmpdir(), "sffmc-shared-test-config")
const configDir = resolve(TEST_HOME)

beforeAll(() => {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
})

describe("loadConfig", () => {
  const defaults = { enabled: true, port: 3000, label: "test" }

  it("returns defaults when no config file exists", async () => {
    const result = await loadConfig("nonexistent", defaults, {
      configHome: configDir,
    })
    expect(result).toEqual(defaults)
  })

  it("merges valid YAML over defaults", async () => {
    const cfgFile = resolve(configDir, "merge-test.yaml")
    writeFileSync(cfgFile, "port: 8080\nlabel: merged\n", "utf-8")

    const result = await loadConfig("merge-test", defaults, {
      configHome: configDir,
    })
    expect(result).toEqual({ enabled: true, port: 8080, label: "merged" })
  })

  it("returns defaults on malformed YAML (no throw)", async () => {
    const cfgFile = resolve(configDir, "malformed.yaml")
    writeFileSync(cfgFile, "port: [unclosed\n", "utf-8")

    const result = await loadConfig("malformed", defaults, {
      configHome: configDir,
    })
    expect(result).toEqual(defaults)
  })

  it("returns defaults when file is empty", async () => {
    const cfgFile = resolve(configDir, "empty.yaml")
    writeFileSync(cfgFile, "", "utf-8")

    const result = await loadConfig("empty", defaults, {
      configHome: configDir,
    })
    expect(result).toEqual(defaults)
  })
})
