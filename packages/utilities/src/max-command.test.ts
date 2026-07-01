// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import { describe, it, expect } from "bun:test"
import { MAX_COMMAND, MAX_PATTERN } from "./max-command.ts"

describe("MAX_COMMAND", () => {
  it("equals '/max'", () => {
    expect(MAX_COMMAND).toBe("/max")
  })
})

describe("MAX_PATTERN", () => {
  it("matches bare '/max'", () => {
    expect(MAX_PATTERN.test("/max")).toBe(true)
  })

  it("matches '/max reset'", () => {
    expect(MAX_PATTERN.test("/max reset")).toBe(true)
  })

  it("matches '/max clear abc'", () => {
    expect(MAX_PATTERN.test("/max clear abc")).toBe(true)
  })

  it("rejects 'max' without slash", () => {
    expect(MAX_PATTERN.test("max")).toBe(false)
  })

  it("rejects '/max unknown'", () => {
    expect(MAX_PATTERN.test("/max unknown")).toBe(false)
  })

  it("is case-insensitive", () => {
    expect(MAX_PATTERN.test("/MAX")).toBe(true)
  })
})
