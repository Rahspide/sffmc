// SPDX-License-Identifier: MIT
// @sffmc/agentic — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import agentic, { id, server } from "./index.ts"
import type { PluginContext } from "@sffmc/shared"

describe("@sffmc/agentic", () => {
  const ctx = {} as PluginContext

  test("id is @sffmc/agentic", () => {
    expect(id).toBe("@sffmc/agentic")
    expect(agentic.id).toBe("@sffmc/agentic")
  })

  test("server returns merged hooks from 4 sub-features", async () => {
    const result = await server(ctx)
    expect(result.id).toBe("@sffmc/agentic")
    // max-mode + workflow + compose + health
    expect(typeof result["tool.execute.before"]).toBe("function")
    expect(typeof result["command.execute.before"]).toBe("function")
    expect(typeof result["experimental.chat.system.transform"]).toBe("function")
    expect(typeof result["experimental.chat.messages.transform"]).toBe("function")
    expect(result.tool).toBeDefined()
  })

  test("server has 3 tools (workflow + compose + health)", async () => {
    const result = await server(ctx)
    expect(Object.keys(result.tool ?? {}).length).toBeGreaterThanOrEqual(3)
  })
})
