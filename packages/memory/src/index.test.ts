// SPDX-License-Identifier: MIT
// @sffmc/memory — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import * as v from "valibot"
import memory, { id, server } from "./index.ts"
import type { PluginContext } from "@sffmc/utilities"

describe("@sffmc/memory", () => {
  // SAFETY: invariant — see caller justification
  const ctx = {} as PluginContext

  test("id is @sffmc/memory", () => {
    expect(id).toBe("@sffmc/memory")
    expect(memory.id).toBe("@sffmc/memory")
  })

  test("server returns merged hooks from 4 sub-features", async () => {
    const result = await server(ctx)
    expect(result.id).toBe("@sffmc/memory")
    // memory + checkpoint + judge + dream
    expect(v.is(v.function_(), result["experimental.chat.messages.transform"])).toBe(true)
    expect(v.is(v.function_(), result["tool.execute.after"])).toBe(true)
  })

  test("server has 3 tools (extra_checkpoint, extra_judge, extra_dream)", async () => {
    const result = await server(ctx)
    expect(result.tool).toBeDefined()
    expect(Object.keys(result.tool ?? {}).sort()).toEqual([
      "extra_checkpoint",
      "extra_dream",
      "extra_judge",
    ])
  })
})
