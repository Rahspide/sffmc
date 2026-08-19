// SPDX-License-Identifier: MIT
// @sffmc/safety — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import * as v from "valibot"
import safety, { id, server } from "./index.ts"
import type { PluginContext } from "@sffmc/utilities";

describe("@sffmc/safety", () => {
  // SAFETY: test mock — empty ctx cast to PluginContext for type signature
  const ctx = {} as PluginContext

  test("id is @sffmc/safety", () => {
    expect(id).toBe("@sffmc/safety")
    expect(safety.id).toBe("@sffmc/safety")
  })

  test("server returns merged hooks from 5 sub-features", async () => {
    const result = await server(ctx)
    expect(result.id).toBe("@sffmc/safety")
    // Should have hooks from watchdog, rules, auto-max, eos-stripper, log-whitelist
    expect(v.is(v.function_(), result["tool.execute.after"])).toBe(true)
    expect(v.is(v.function_(), result["tool.execute.before"])).toBe(true)
    expect(v.is(v.function_(), result["command.execute.before"])).toBe(true)
    expect(v.is(v.function_(), result["permission.ask"])).toBe(true)
    expect(v.is(v.function_(), result["experimental.chat.system.transform"])).toBe(true)
    expect(v.is(v.function_(), result["experimental.text.complete"])).toBe(true)
  })

  test("server has no tool key (safety has 0 tools)", async () => {
    const result = await server(ctx)
    expect(result.tool).toBeUndefined()
  })
})
