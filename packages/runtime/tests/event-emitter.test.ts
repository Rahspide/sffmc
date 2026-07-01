// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// TDD interface tests for WorkflowEventEmitter — extracted from WorkflowRuntime
// (M-1 god-object refactor, Task 1.3).
//
// The brief's sketched interface (`on()` returning an unsubscribe function)
// didn't match the real WorkflowRuntime events bus API, which uses a key-based
// `on()` / `off()` pair (the 33 characterization tests in
// `runtime-external-api.test.ts` pin this exact shape: `on` returns a string
// key, `off(key)` unsubscribes, `clearAll()` wipes all listeners). These tests
// pin the real semantics so the refactor from `createEventBus()` to a
// `WorkflowEventEmitter` class doesn't drift the public event-bus contract.

import { describe, test, expect } from "bun:test"
import { WorkflowEventEmitter } from "../src/event-emitter.ts"

describe("WorkflowEventEmitter — on()/emit() roundtrip", () => {
  test("on() registers a listener that fires on emit() with the payload", () => {
    const bus = new WorkflowEventEmitter()
    let received: unknown = null
    bus.on("workflow:started", (e) => {
      received = e
    })
    bus.emit("workflow:started", { runID: "wf_1", name: "test" })
    expect(received).toEqual({ runID: "wf_1", name: "test" })
  })

  test("on() returns a key string (the API contract pins this for off())", () => {
    const bus = new WorkflowEventEmitter()
    const key = bus.on("workflow:started", () => {})
    expect(typeof key).toBe("string")
    expect(key.length).toBeGreaterThan(0)
  })

  test("two on() calls on the same event return distinct keys", () => {
    const bus = new WorkflowEventEmitter()
    const k1 = bus.on("workflow:started", () => {})
    const k2 = bus.on("workflow:started", () => {})
    expect(k1).not.toBe(k2)
  })

  test("emit() with no listeners is a no-op (no throw)", () => {
    const bus = new WorkflowEventEmitter()
    expect(() =>
      bus.emit("workflow:finished", { runID: "wf_x", status: "completed" }),
    ).not.toThrow()
  })

  test("emit() does not fire listeners registered for a different event", () => {
    const bus = new WorkflowEventEmitter()
    let calls = 0
    bus.on("workflow:started", () => {
      calls++
    })
    bus.emit("workflow:finished", { runID: "wf_x", status: "completed" })
    expect(calls).toBe(0)
  })

  test("multiple listeners on the same event all fire, in registration order", () => {
    const bus = new WorkflowEventEmitter()
    const order: number[] = []
    bus.on("workflow:phase", () => order.push(1))
    bus.on("workflow:phase", () => order.push(2))
    bus.on("workflow:phase", () => order.push(3))
    bus.emit("workflow:phase", { runID: "wf_1", title: "T" })
    expect(order).toEqual([1, 2, 3])
  })

  test("different events have independent listener lists", () => {
    const bus = new WorkflowEventEmitter()
    const startedCalls: string[] = []
    const finishedCalls: string[] = []
    bus.on("workflow:started", (e) => startedCalls.push(e.name))
    bus.on("workflow:finished", (e) => finishedCalls.push(e.runID))
    bus.emit("workflow:started", { runID: "wf_1", name: "alpha" })
    bus.emit("workflow:finished", { runID: "wf_1", status: "completed" })
    expect(startedCalls).toEqual(["alpha"])
    expect(finishedCalls).toEqual(["wf_1"])
  })
})

describe("WorkflowEventEmitter — off()", () => {
  test("off() removes a previously registered listener", () => {
    const bus = new WorkflowEventEmitter()
    let calls = 0
    const key = bus.on("workflow:started", () => {
      calls++
    })
    bus.emit("workflow:started", { runID: "wf_A", name: "a" })
    bus.off(key)
    bus.emit("workflow:started", { runID: "wf_B", name: "b" })
    expect(calls).toBe(1)
  })

  test("off() with an unknown key is a no-op (no throw, no side-effect)", () => {
    const bus = new WorkflowEventEmitter()
    let calls = 0
    bus.on("workflow:started", () => {
      calls++
    })
    bus.off("not-a-real-key")
    bus.emit("workflow:started", { runID: "wf_1", name: "x" })
    expect(calls).toBe(1)
  })

  test("off() removes one listener without affecting the others on the same event", () => {
    const bus = new WorkflowEventEmitter()
    let a = 0
    let b = 0
    const keyA = bus.on("workflow:phase", () => a++)
    bus.on("workflow:phase", () => b++)
    bus.off(keyA)
    bus.emit("workflow:phase", { runID: "wf_1", title: "T" })
    expect(a).toBe(0)
    expect(b).toBe(1)
  })

  test("off() during emit() (a listener unsubscribes itself) does not break the loop", () => {
    const bus = new WorkflowEventEmitter()
    let secondCallCount = 0
    const key = bus.on("workflow:phase", () => {
      // The current emit iteration must still complete; subsequent emits
      // for this listener should be silent.
      bus.off(key)
    })
    bus.on("workflow:phase", () => {
      secondCallCount++
    })
    expect(() =>
      bus.emit("workflow:phase", { runID: "wf_1", title: "T" }),
    ).not.toThrow()
    // The second listener fires on this emit (listener removed after its iteration).
    expect(secondCallCount).toBe(1)
    // Subsequent emits: first listener is gone, only the second fires.
    bus.emit("workflow:phase", { runID: "wf_1", title: "T2" })
    expect(secondCallCount).toBe(2)
  })
})

describe("WorkflowEventEmitter — clearAll()", () => {
  test("clearAll() removes all listeners across all events", () => {
    const bus = new WorkflowEventEmitter()
    let s = 0
    let p = 0
    bus.on("workflow:started", () => s++)
    bus.on("workflow:phase", () => p++)
    bus.clearAll()
    bus.emit("workflow:started", { runID: "wf_1", name: "x" })
    bus.emit("workflow:phase", { runID: "wf_1", title: "T" })
    expect(s).toBe(0)
    expect(p).toBe(0)
  })

  test("clearAll() on an empty bus is a no-op (no throw)", () => {
    const bus = new WorkflowEventEmitter()
    expect(() => bus.clearAll()).not.toThrow()
    expect(() => bus.clearAll()).not.toThrow()
  })

  test("after clearAll(), previously-issued keys are no longer valid (off is a no-op)", () => {
    const bus = new WorkflowEventEmitter()
    const key = bus.on("workflow:started", () => {})
    bus.clearAll()
    // off() with a now-stale key should not throw.
    expect(() => bus.off(key)).not.toThrow()
  })
})

describe("WorkflowEventEmitter — listener error isolation", () => {
  test("a listener that throws does not prevent subsequent listeners from firing", () => {
    const bus = new WorkflowEventEmitter()
    const log: string[] = []
    bus.on("workflow:phase", () => {
      log.push("a")
    })
    bus.on("workflow:phase", () => {
      log.push("b-throw")
      throw new Error("listener boom")
    })
    bus.on("workflow:phase", () => {
      log.push("c")
    })
    // Swallow stderr noise from the expected log.error() inside emit().
    // The contract: subsequent listeners still fire.
    bus.emit("workflow:phase", { runID: "wf_1", title: "T" })
    expect(log).toEqual(["a", "b-throw", "c"])
  })
})

describe("WorkflowEventEmitter — payload shape (real workflow event names)", () => {
  test("delivers workflow:agent_failed payload with reason field", () => {
    const bus = new WorkflowEventEmitter()
    let received: unknown = null
    bus.on("workflow:agent_failed", (e) => {
      received = e
    })
    bus.emit("workflow:agent_failed", {
      runID: "wf_a",
      agentKey: "k1",
      reason: "timeout",
    })
    expect(received).toEqual({ runID: "wf_a", agentKey: "k1", reason: "timeout" })
  })

  test("delivers workflow:step_checkpoint payload with stepIndex + costTokens", () => {
    const bus = new WorkflowEventEmitter()
    let received: unknown = null
    bus.on("workflow:step_checkpoint", (e) => {
      received = e
    })
    bus.emit("workflow:step_checkpoint", {
      runID: "wf_a",
      stepIndex: 7,
      costTokens: 1234,
    })
    expect(received).toEqual({ runID: "wf_a", stepIndex: 7, costTokens: 1234 })
  })

  test("delivers workflow:log payload (the highest-frequency event)", () => {
    const bus = new WorkflowEventEmitter()
    const log: string[] = []
    bus.on("workflow:log", (e) => log.push(e.message))
    bus.emit("workflow:log", { runID: "wf_1", message: "hello" })
    bus.emit("workflow:log", { runID: "wf_1", message: "world" })
    expect(log).toEqual(["hello", "world"])
  })
})

describe("WorkflowEventEmitter — emit() copies the listener list (mutation-safe)", () => {
  test("a listener that adds a new listener during emit() does not affect the current emit", () => {
    const bus = new WorkflowEventEmitter()
    let secondFired = false
    bus.on("workflow:phase", () => {
      bus.on("workflow:phase", () => {
        secondFired = true
      })
    })
    // The newly-added listener should NOT fire on the same emit.
    bus.emit("workflow:phase", { runID: "wf_1", title: "T" })
    expect(secondFired).toBe(false)
    // But it fires on the next emit.
    bus.emit("workflow:phase", { runID: "wf_1", title: "T2" })
    expect(secondFired).toBe(true)
  })
})
