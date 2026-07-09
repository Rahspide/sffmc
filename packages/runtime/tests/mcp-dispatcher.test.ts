// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect, beforeEach } from "bun:test"
import { McpDispatcher } from "../src/mcp-dispatcher.ts"
import type { InternalRunEntry } from "../src/internal-run-entry.ts"

// Fake bridge that captures bookkeeping calls.
function makeFakeBridge() {
  const calls: Array<{ method: string; name?: string; args?: unknown; reason?: string }> = []
  const bridge = {
    checkBudget: (): string | null => {
      if (bridge._budgetReject !== null) {
        return bridge._budgetReject
      }
      return null
    },
    recordRejected: (name: string, args: unknown, reason: string) => {
      calls.push({ method: "recordRejected", name, args, reason })
    },
    recordError: (name: string, args: unknown, reason: string) => {
      calls.push({ method: "recordError", name, args, reason })
    },
    recordCall: (name: string, args: unknown) => {
      calls.push({ method: "recordCall", name, args })
    },
    enterDispatch: (): boolean => {
      if (bridge._rejectEnter) return false
      bridge._entered = true
      return true
    },
    leaveDispatch: () => {
      bridge._entered = false
    },
    _budgetReject: null as string | null,
    _rejectEnter: false,
    _entered: false,
    _calls: calls,
  }
  return bridge
}

function makeEntry(bridge: ReturnType<typeof makeFakeBridge>): InternalRunEntry {
  return {
    runID: "run_test",
    mcpBridge: bridge,
  } as unknown as InternalRunEntry
}

function makeCtxWithTool(toolCall: (n: string, a: unknown) => Promise<unknown>) {
  return {
    client: {
      tool: { call: toolCall },
    },
  } as ConstructorParameters<typeof McpDispatcher>[0]["getCtx"] extends () => infer C ? C : never
}

describe("McpDispatcher", () => {
  let dispatcher: McpDispatcher
  let ctx: ReturnType<typeof makeCtxWithTool>
  let entry: InternalRunEntry
  let bridge: ReturnType<typeof makeFakeBridge>

  beforeEach(() => {
    ctx = makeCtxWithTool(async () => "ok")
    dispatcher = new McpDispatcher({ getCtx: () => ctx })
    bridge = makeFakeBridge()
    entry = makeEntry(bridge)
  })

  // ── call() ───────────────────────────────────────────────────────────

  describe("call", () => {
    it("dispatches through ctx.client.tool.call and records success", async () => {
      const result = await dispatcher.call(entry, "myTool", { foo: 1 })
      expect(result).toBe("ok")
      expect(bridge._calls).toEqual([{ method: "recordCall", name: "myTool", args: { foo: 1 } }])
    })

    it("rejects when budget is exhausted and does not call the SDK", async () => {
      bridge._budgetReject = "MCP budget exceeded: 100 calls"
      const toolCall = (() => { throw new Error("should not be called") }) as (n: string, a: unknown) => Promise<unknown>
      const ctx2 = makeCtxWithTool(toolCall)
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/budget exceeded/)
      expect(bridge._calls[0]?.method).toBe("recordRejected")
      expect(bridge._calls[0]?.reason).toBe("MCP budget exceeded: 100 calls")
    })

    it("rejects on recursion depth and does not call the SDK", async () => {
      bridge._rejectEnter = true
      const toolCall = (() => { throw new Error("should not be called") }) as (n: string, a: unknown) => Promise<unknown>
      const ctx2 = makeCtxWithTool(toolCall)
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/recursion depth limit exceeded/)
      expect(bridge._calls[0]?.method).toBe("recordRejected")
      expect(bridge._calls[0]?.reason).toBe("MCP recursion depth exceeded")
    })

    it("fails closed when ctx.client.tool.call is missing", async () => {
      const ctx2 = { client: {} } as any
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/no MCP SDK surface/)
      expect(bridge._calls[0]?.method).toBe("recordError")
    })

    it("fails closed when ctx.client is missing", async () => {
      const ctx2 = {} as any
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/no MCP SDK surface/)
    })

    it("fails closed when ctx.client.tool is missing", async () => {
      const ctx2 = { client: { tool: {} } } as any
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/no MCP SDK surface/)
    })

    it("records error and propagates SDK failures (non-recursion)", async () => {
      const ctx2 = makeCtxWithTool(async () => { throw new Error("SDK boom") })
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await expect(d2.call(entry, "myTool", { foo: 1 })).rejects.toThrow(/SDK boom/)
      expect(bridge._calls[0]?.method).toBe("recordError")
      expect(bridge._calls[0]?.reason).toBe("SDK boom")
    })

    it("does NOT recordError when the throw is the 'no MCP SDK surface' guard", async () => {
      const ctx2 = { client: {} } as any
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await d2.call(entry, "myTool", { foo: 1 }).catch(() => {})
      // recordError is called once (for the guard itself), but we want to
      // verify the 'no MCP SDK surface' message is NOT double-recorded
      // by the catch-all branch. Only one recordError call should happen.
      const errCalls = bridge._calls.filter(c => c.method === "recordError")
      expect(errCalls).toHaveLength(1)
      expect(errCalls[0]?.reason).toBe("no MCP SDK surface available")
    })

    it("leaveDispatch is called on success", async () => {
      await dispatcher.call(entry, "myTool", { foo: 1 })
      expect(bridge._entered).toBe(false)
    })

    it("leaveDispatch is called on budget rejection (no enterDispatch call)", async () => {
      bridge._budgetReject = "MCP budget exceeded: 100 calls"
      const ctx2 = makeCtxWithTool(async () => "ok")
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await d2.call(entry, "myTool", { foo: 1 }).catch(() => {})
      // Budget reject happens before enterDispatch, so _entered stays false
      expect(bridge._entered).toBe(false)
    })

    it("leaveDispatch is called on SDK error (finally block)", async () => {
      const ctx2 = makeCtxWithTool(async () => { throw new Error("SDK boom") })
      const d2 = new McpDispatcher({ getCtx: () => ctx2 })
      await d2.call(entry, "myTool", { foo: 1 }).catch(() => {})
      expect(bridge._entered).toBe(false)
    })
  })
})
