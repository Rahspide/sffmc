// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { describe, test, expect, mock } from "bun:test"
import {
  mergeHooks,
  TRANSFORM_HOOKS,
  GATE_HOOKS,
  SIDE_EFFECT_HOOKS,
} from "./merge-hooks.ts"
import type { PluginServer } from "./merge-hooks.ts"

describe("mergeHooks", () => {
  test("empty servers returns default id", () => {
    const result = mergeHooks([])
    expect(result.id).toBe("merged")
    // no other keys
    expect(Object.keys(result)).toEqual(["id"])
  })

  test("transform chains in registration order", async () => {
    // 3 handlers for messages.transform: [0] appends A, [1] appends B, [2] appends C
    const s0: PluginServer = {
      id: "s0",
      "experimental.chat.messages.transform": async (_ctx: unknown, msgs: unknown[]) => [...msgs, "A"],
    }
    const s1: PluginServer = {
      id: "s1",
      "experimental.chat.messages.transform": async (_ctx: unknown, msgs: unknown[]) => [...msgs, "B"],
    }
    const s2: PluginServer = {
      id: "s2",
      "experimental.chat.messages.transform": async (_ctx: unknown, msgs: unknown[]) => [...msgs, "C"],
    }

    const merged = mergeHooks([s0, s1, s2])
    const transform = merged["experimental.chat.messages.transform"] as (...args: unknown[]) => Promise<unknown>
    const result = await transform({ role: "user" }, [{ role: "system" }])

    // s0 output feeds s1 input feeds s2 input → final is [system, A, B, C]
    expect(result).toEqual([{ role: "system" }, "A", "B", "C"])
  })

  test("gate returns first truthy", async () => {
    const spy2 = mock(() => "SHOULD NOT RUN")
    const s0: PluginServer = {
      id: "s0",
      "tool.execute.before": async () => undefined,
    }
    const s1: PluginServer = {
      id: "s1",
      "tool.execute.before": async () => "BLOCK: rate limit",
    }
    const s2: PluginServer = {
      id: "s2",
      "tool.execute.before": spy2,
    }

    const merged = mergeHooks([s0, s1, s2])
    const gate = merged["tool.execute.before"] as (...args: unknown[]) => Promise<unknown>
    const result = await gate("read", { path: "/x" })

    expect(result).toBe("BLOCK: rate limit")
    expect(spy2).not.toHaveBeenCalled()
  })

  test("side effect calls all with same args", async () => {
    const spy0 = mock((_cfg: unknown) => {})
    const spy1 = mock((_cfg: unknown) => {})
    const spy2 = mock((_cfg: unknown) => {})

    const servers: PluginServer[] = [
      { id: "s0", config: spy0 },
      { id: "s1", config: spy1 },
      { id: "s2", config: spy2 },
    ]

    const merged = mergeHooks(servers)
    const configHook = merged.config as (...args: unknown[]) => Promise<unknown>
    const cfg = { foo: 1 }
    await configHook(cfg)

    expect(spy0).toHaveBeenCalledWith(cfg)
    expect(spy1).toHaveBeenCalledWith(cfg)
    expect(spy2).toHaveBeenCalledWith(cfg)
    expect(spy0).toHaveBeenCalledTimes(1)
    expect(spy1).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
  })

  test("tool merges with later wins and warns", () => {
    const warnSpy = mock((_msg: string) => {})
    const orig = console.warn
    console.warn = warnSpy

    try {
      const s0: PluginServer = {
        id: "s0",
        tool: { X: { description: "from s0", execute: "fn0" } },
      }
      const s1: PluginServer = {
        id: "s1",
        tool: { X: { description: "from s1", execute: "fn1" } },
      }

      const merged = mergeHooks([s0, s1])
      const toolX = (merged.tool as Record<string, unknown>)["X"] as Record<string, unknown>

      // later (s1) wins
      expect(toolX.description).toBe("from s1")
      expect(toolX.execute).toBe("fn1")

      // warn called once for the collision
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      console.warn = orig
    }
  })

  test("missing handler in some servers is skipped", async () => {
    const spy0 = mock((_cfg: unknown) => {})
    const spy2 = mock((_cfg: unknown) => {})

    const servers: PluginServer[] = [
      { id: "s0", config: spy0 },
      { id: "s1" }, // no config
      { id: "s2", config: spy2 },
    ]

    const merged = mergeHooks(servers)
    const configHook = merged.config as (...args: unknown[]) => Promise<unknown>
    await configHook({ bar: 2 })

    expect(spy0).toHaveBeenCalledTimes(1)
    expect(spy2).toHaveBeenCalledTimes(1)
    // s1 has no config handler, should not be invoked — both spies called once
  })
})
