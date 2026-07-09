import { describe, test, expect } from "bun:test"
import { toErrorMessage } from "../src/errors.ts"

describe("toErrorMessage", () => {
  test("Error instance → .message", () => {
    expect(toErrorMessage(new Error("boom"))).toBe("boom")
  })

  test("plain string → String(s)", () => {
    expect(toErrorMessage("oops")).toBe("oops")
  })

  test("plain object → String(obj)", () => {
    const obj = { code: 42 }
    expect(toErrorMessage(obj)).toBe(String(obj))
  })
})