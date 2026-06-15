// SPDX-License-Identifier: MIT
// @sffmc/agentic — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import type { PluginContext } from "@sffmc/shared"
import plugin from "./index"

describe("@sffmc/agentic skeleton", () => {
  test("returns id", async () => {
    const ctx = {} as PluginContext
    const result = await plugin.server(ctx)
    expect(result.id).toBe("@sffmc/agentic")
  })

  test("has no hooks (Phase 1 skeleton)", async () => {
    const ctx = {} as PluginContext
    const result = await plugin.server(ctx)
    const hooks = Object.keys(result).filter(k => k !== "id")
    expect(hooks).toEqual([])
  })
})
