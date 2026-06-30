// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect } from "bun:test"

import { isSafeRunID, RUN_ID_REGEX, safeRunID } from "./safe-run-id.ts"

describe("RUN_ID_REGEX", () => {
  it("matches the wf_ + 26 base62 chars format", () => {
    const id = "wf_" + "0".repeat(26)
    expect(RUN_ID_REGEX.test(id)).toBe(true)
  })

  it("matches mixed case base62", () => {
    const id = "wf_ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    expect(RUN_ID_REGEX.test(id)).toBe(true)
    const id2 = "wf_abcdefghijklmnopqrstuvwxyz"
    expect(RUN_ID_REGEX.test(id2)).toBe(true)
    const id3 = "wf_0123456789abcdef0123456789"
    expect(RUN_ID_REGEX.test(id3)).toBe(true)
  })
})

describe("isSafeRunID", () => {
  it("accepts well-formed wf_ IDs", () => {
    expect(isSafeRunID("wf_" + "0".repeat(26))).toBe(true)
    expect(isSafeRunID("wf_ABCDEFGHIJKLMNOPQRSTUVWXyz")).toBe(true)
  })

  it("rejects empty string", () => {
    expect(isSafeRunID("")).toBe(false)
  })

  it("rejects wrong prefix", () => {
    expect(isSafeRunID("xx_" + "0".repeat(26))).toBe(false)
    expect(isSafeRunID("wf-" + "0".repeat(26))).toBe(false)
  })

  it("rejects too-short body", () => {
    expect(isSafeRunID("wf_" + "0".repeat(25))).toBe(false)
  })

  it("rejects too-long body", () => {
    expect(isSafeRunID("wf_" + "0".repeat(27))).toBe(false)
  })

  it("rejects characters outside [0-9A-Za-z]", () => {
    expect(isSafeRunID("wf_" + "z".repeat(25) + "!")).toBe(false)
    expect(isSafeRunID("wf_" + "z".repeat(25) + "/")).toBe(false)
  })

  it("does not throw on any input", () => {
    const samples = ["", "wf_", "wf_abc", "\0wf_xxx", "wf_" + "0".repeat(26)]
    for (const s of samples) expect(() => isSafeRunID(s)).not.toThrow()
  })
})

describe("safeRunID", () => {
  it("is a void function (returns undefined) for valid IDs", () => {
    const valid = "wf_" + "A".repeat(26)
    const ret = safeRunID(valid)
    expect(ret).toBeUndefined()
  })

  it("throws for invalid IDs", () => {
    expect(() => safeRunID("not-a-run-id")).toThrow(/invalid workflow runID/)
  })

  it("includes the offending value in the error message (JSON-encoded)", () => {
    const bogus = "bad\0id"
    try {
      safeRunID(bogus)
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as Error).message).toContain(JSON.stringify(bogus))
    }
  })

  it("isSafeRunID and safeRunID agree: safe ↔ does-not-throw", () => {
    const samples = [
      "",
      "wf_",
      "wf_" + "0".repeat(26),
      "wf_" + "0".repeat(25),
      "xx_" + "0".repeat(26),
      "wf_" + "a".repeat(26),
    ]
    for (const s of samples) {
      let threw = false
      try {
        safeRunID(s)
      } catch {
        threw = true
      }
      expect(threw).toBe(!isSafeRunID(s))
    }
  })
})
