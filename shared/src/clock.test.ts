// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, it, expect, afterEach } from "bun:test"

import { __resetClock, __setClock, SECONDS_PER_DAY, unixNow } from "./time.ts"

afterEach(() => {
  __resetClock()
})

describe("unixNow", () => {
  it("returns a positive integer", () => {
    const n = unixNow()
    expect(n).toBeGreaterThan(0)
    expect(Number.isInteger(n)).toBe(true)
  })

  it("returns a value close to the real wall clock by default", () => {
    const before = Math.floor(Date.now() / 1000)
    const n = unixNow()
    const after = Math.floor(Date.now() / 1000)
    expect(n).toBeGreaterThanOrEqual(before)
    expect(n).toBeLessThanOrEqual(after)
  })
})

describe("SECONDS_PER_DAY", () => {
  it("equals 86400", () => {
    expect(SECONDS_PER_DAY).toBe(24 * 60 * 60)
  })
})

describe("__setClock", () => {
  it("returns the fixed value while the override is active", () => {
    __setClock(() => 1_700_000_000)
    expect(unixNow()).toBe(1_700_000_000)
    expect(unixNow()).toBe(1_700_000_000)
  })

  it("supports a clock that advances on each call", () => {
    let t = 1_700_000_000
    __setClock(() => t++)
    expect(unixNow()).toBe(1_700_000_000)
    expect(unixNow()).toBe(1_700_000_001)
    expect(unixNow()).toBe(1_700_000_002)
  })

  it("restores the real wall clock when set to null", () => {
    __setClock(() => 999)
    expect(unixNow()).toBe(999)
    __setClock(null)
    const real = unixNow()
    expect(real).toBeGreaterThan(1_000_000_000)
  })
})

describe("__resetClock", () => {
  it("restores the wall clock after a clock injection", () => {
    __setClock(() => 999)
    __resetClock()
    expect(unixNow()).not.toBe(999)
  })
})

describe("clock + SECONDS_PER_DAY combinator", () => {
  it("lets a test pin 'now' and compute a 30-day threshold deterministically", () => {
    const nowSec = 1_700_000_000
    __setClock(() => nowSec)
    const threshold = unixNow() - 30 * SECONDS_PER_DAY
    expect(threshold).toBe(1_700_000_000 - 2_592_000)
  })
})
