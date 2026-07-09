// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect, beforeEach, mock } from "bun:test"
import { callLLM, type CallLLMResult } from "../src/llm-call.ts"
import type { AgentOptions, InternalRunEntry, PluginContext } from "../src/types.ts"

// Minimal stand-ins. We do NOT want to construct a full InternalRunEntry or
// PluginContext — the function under test only needs them to exist (callLLM
// does not read fields from entry in the current implementation; if that
// changes the test fixtures will need to grow).
const fakeEntry: InternalRunEntry = {} as InternalRunEntry

const baseOpts = (overrides: Partial<AgentOptions> = {}): AgentOptions => ({
  task: "test",
  ...overrides,
} as AgentOptions)

describe("callLLM", () => {
  beforeEach(() => {
    // Reset module-level mocks between tests (bun:test mock state is per-test)
  })

  it("uses JSON schema system prompt when opts.schema is set", async () => {
    let capturedMessages: Array<{ role: string; content: string }> = []
    const ctx: PluginContext = {
      client: {
        session: {
          message: async (args: { messages: Array<{ role: string; content: string }> }) => {
            capturedMessages = args.messages
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      },
    } as unknown as PluginContext
    await callLLM(ctx, fakeEntry, "do the thing", baseOpts({ schema: { type: "object" } }))
    expect(capturedMessages[0]?.role).toBe("system")
    expect(capturedMessages[0]?.content).toContain("valid JSON")
  })

  it("uses plain system prompt when opts.schema is absent", async () => {
    let capturedMessages: Array<{ role: string; content: string }> = []
    const ctx: PluginContext = {
      client: {
        session: {
          message: async (args: { messages: Array<{ role: string; content: string }> }) => {
            capturedMessages = args.messages
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      },
    } as unknown as PluginContext
    await callLLM(ctx, fakeEntry, "do the thing", baseOpts())
    expect(capturedMessages[0]?.content).toContain("directly")
    expect(capturedMessages[0]?.content).not.toContain("JSON")
  })

  it("appends the user message after the system prompt", async () => {
    let captured: { messages: Array<{ role: string; content: string }> } | null = null
    const ctx: PluginContext = {
      client: {
        session: {
          message: async (args: { messages: Array<{ role: string; content: string }> }) => {
            captured = args
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      },
    } as unknown as PluginContext
    await callLLM(ctx, fakeEntry, "the prompt", baseOpts())
    expect(captured).not.toBeNull()
    expect(captured!.messages).toHaveLength(2)
    expect(captured!.messages[0]?.role).toBe("system")
    expect(captured!.messages[1]?.role).toBe("user")
    expect(captured!.messages[1]?.content).toBe("the prompt")
  })

  it("forwards opts.model to the SDK call", async () => {
    let capturedModel: unknown = "unset"
    const ctx: PluginContext = {
      client: {
        session: {
          message: async (args: { model: unknown }) => {
            capturedModel = args.model
            return { content: [{ type: "text", text: "ok" }] }
          },
        },
      },
    } as unknown as PluginContext
    await callLLM(ctx, fakeEntry, "x", baseOpts({ model: "gpt-4o-mini" }))
    expect(capturedModel).toBe("gpt-4o-mini")
  })

  it("returns the fallback result when ctx.client.session.message is missing", async () => {
    const ctx: PluginContext = {} as PluginContext
    const r = await callLLM(ctx, fakeEntry, "x", baseOpts())
    expect(r.content).toHaveLength(1)
    expect(r.content[0]?.text).toContain("no LLM client available")
  })

  it("returns the fallback result when ctx.client is undefined", async () => {
    const ctx: PluginContext = {} as PluginContext
    const r = await callLLM(ctx, fakeEntry, "x", baseOpts())
    expect(r.content[0]?.text).toContain("no LLM client")
  })

  it("returns the fallback result when ctx.client.session is undefined", async () => {
    const ctx = { client: {} } as unknown as PluginContext
    const r = await callLLM(ctx, fakeEntry, "x", baseOpts())
    expect(r.content[0]?.text).toContain("no LLM client")
  })

  it("returns the fallback result when ctx.client.session.message is undefined", async () => {
    const ctx = { client: { session: {} } } as unknown as PluginContext
    const r = await callLLM(ctx, fakeEntry, "x", baseOpts())
    expect(r.content[0]?.text).toContain("no LLM client")
  })
})
