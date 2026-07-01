// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import safety, { id, server } from "./index.ts"
import type { PluginContext } from "@sffmc/utilities";

describe("@sffmc/safety", () => {
  const ctx = {} as PluginContext

  test("id is @sffmc/safety", () => {
    expect(id).toBe("@sffmc/safety")
    expect(safety.id).toBe("@sffmc/safety")
  })

  test("server returns merged hooks from 5 sub-features", async () => {
    const result = await server(ctx)
    expect(result.id).toBe("@sffmc/safety")
    // Should have hooks from watchdog, rules, auto-max, eos-stripper, log-whitelist
    expect(typeof result["tool.execute.after"]).toBe("function")
    expect(typeof result["tool.execute.before"]).toBe("function")
    expect(typeof result["command.execute.before"]).toBe("function")
    expect(typeof result["permission.ask"]).toBe("function")
    expect(typeof result["experimental.chat.system.transform"]).toBe("function")
    expect(typeof result["experimental.text.complete"]).toBe("function")
  })

  test("server has no tool key (safety has 0 tools)", async () => {
    const result = await server(ctx)
    expect(result.tool).toBeUndefined()
  })
})
