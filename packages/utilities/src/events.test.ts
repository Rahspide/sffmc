// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import { describe, it, expect, beforeEach } from "bun:test"
import { on, off, emit, clearAll } from "./events.ts"

describe("EventBus", () => {
  beforeEach(() => {
    clearAll()
  })

  it("on → emit fires handler", () => {
    let received = 0
    on("test", (n: number) => {
      received = n
    })
    emit("test", 42)
    expect(received).toBe(42)
  })

  it("off removes handler", () => {
    let received = 0
    const handler = (n: number) => {
      received = n
    }
    on("test", handler)
    off("test", handler)
    emit("test", 99)
    expect(received).toBe(0)
  })

  it("multiple handlers fire in registration order", () => {
    const order: number[] = []
    on("test", () => order.push(1))
    on("test", () => order.push(2))
    on("test", () => order.push(3))
    emit("test", null)
    expect(order).toEqual([1, 2, 3])
  })

  it("clearAll removes all handlers", () => {
    let count = 0
    on("test", () => count++)
    on("test", () => count++)
    on("other", () => count++)
    clearAll()
    emit("test", null)
    emit("other", null)
    expect(count).toBe(0)
  })

  it("emit with no listeners is a no-op (does not throw)", () => {
    expect(() => emit("no-such-event", { x: 1 })).not.toThrow()
  })

  it("off with non-existent event is a no-op", () => {
    const handler = () => {}
    expect(() => off("never-registered", handler)).not.toThrow()
  })

  it("off with non-existent handler on a registered event is a no-op", () => {
    on("test", () => {})
    const otherHandler = () => {}
    expect(() => off("test", otherHandler)).not.toThrow()
  })

  it("throwing handler does not break other handlers (defense-in-depth)", () => {
    // The docstring guarantees that a throwing listener is silently
    // caught so that a buggy plugin can't break the whole event chain.
    // Lock that contract down — if a future refactor drops the try/catch,
    // this test fails immediately.
    const before: number[] = []
    const after: number[] = []
    on("test", () => before.push(1))
    on("test", () => {
      throw new Error("intentional")
    })
    on("test", () => after.push(1))
    expect(() => emit("test", null)).not.toThrow()
    expect(before).toEqual([1])
    expect(after).toEqual([1])
  })

  it("handler that re-enters via off() during emit() does not break iteration", () => {
    // The impl iterates a copy (`[...list]`) so a listener that calls
    // off() to remove itself (or another listener) does not perturb the
    // current dispatch. Lock that contract.
    let secondFired = false
    let firstFired = false
    const first = () => {
      firstFired = true
      off("test", first)
    }
    const second = () => {
      secondFired = true
    }
    on("test", first)
    on("test", second)
    emit("test", null)
    expect(firstFired).toBe(true)
    expect(secondFired).toBe(true)
    // After the dispatch, first is gone; re-emit only fires second.
    firstFired = false
    secondFired = false
    emit("test", null)
    expect(firstFired).toBe(false)
    expect(secondFired).toBe(true)
  })

  it("same handler registered twice fires twice", () => {
    let count = 0
    const handler = () => count++
    on("test", handler)
    on("test", handler)
    emit("test", null)
    expect(count).toBe(2)
  })

  it("on() returns unique keys per registration", () => {
    const k1 = on("test", () => {})
    const k2 = on("test", () => {})
    const k3 = on("other", () => {})
    expect(k1).not.toBe(k2)
    expect(k2).not.toBe(k3)
    expect(k1).not.toBe(k3)
  })
})