// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect } from "bun:test"
import { extractErrorType, isToolError } from "./errors.ts"

describe("extractErrorType", () => {
  it("returns UNKNOWN for null", () => {
    expect(extractErrorType(null)).toBe("UNKNOWN")
  })

  it("returns UNKNOWN for undefined", () => {
    expect(extractErrorType(undefined)).toBe("UNKNOWN")
  })

  it("returns UNKNOWN for a clean success string", () => {
    expect(extractErrorType("everything is fine")).toBe("UNKNOWN")
  })

  it("detects ENOENT in a string", () => {
    expect(extractErrorType("ENOENT: no such file or directory")).toBe("ENOENT")
  })

  it("detects Error: prefix in a string", () => {
    expect(extractErrorType("Error: something broke")).toBe("ERROR:")
  })

  it("detects ERR_ pattern in a string", () => {
    expect(extractErrorType("ERR_MODULE_NOT_FOUND: cannot find module")).toBe("ERR_")
  })

  it("falls back to object.code when no string match", () => {
    expect(extractErrorType({ code: "MY_ERROR" })).toBe("MY_ERROR")
  })

  it("falls back to object.name when no code", () => {
    expect(extractErrorType({ name: "TypeError", message: "bad type" })).toBe("TypeError")
  })

  it("returns UNKNOWN for a number input", () => {
    expect(extractErrorType(42)).toBe("UNKNOWN")
  })
})

describe("isToolError", () => {
  it("returns false for null", () => {
    expect(isToolError(null)).toBe(false)
  })

  it("returns false for a clean success string", () => {
    expect(isToolError("command completed successfully")).toBe(false)
  })

  it("returns false for non-error strings containing 'fail' prefix", () => {
    // "failsafe" is a false positive in auto-max's loose /error|fail/i pattern
    expect(isToolError("failsafe mode activated")).toBe(false)
  })

  it("detects 'Error: something' pattern", () => {
    expect(isToolError("Error: something went wrong")).toBe(true)
  })

  it("returns true for long output > 4096 chars", () => {
    const long = "x".repeat(5000)
    expect(isToolError(long)).toBe(true)
  })

  it("detects ENOENT in output", () => {
    expect(isToolError("ENOENT: no such file, open '/tmp/x'")).toBe(true)
  })

  it("returns false for a number input", () => {
    expect(isToolError(123)).toBe(false)
  })
})
