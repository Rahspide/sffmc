// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

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
})
