// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// Shared helpers for the coverage test suite. Existing files (resume.test.ts,
// runtime-coverage.test.ts, journal-race.test.ts) each set up their own
// tmpDir + persistence; this module is for new tests that need mock
// PluginContexts or pre-canned journal seeds.

import type { PluginContext } from "../src/runtime.ts"

/** Mock PluginContext with NO LLM client. Used by callLLM fallback tests
 *  (runtime.ts:803-804 — returns the "no LLM client available" message). */
export function makeNoClientCtx(): PluginContext {
  return {
    config: {},
    // deliberately no `client` field — `ctx.client?.session?.message` is undefined
  }
}

/** Build a PluginContext whose `session.message` is a spy that records every
 *  call. Used to assert that callLLM forwards `tools: "INHERIT"` vs the
 *  concrete array correctly (runtime.ts:791-794). */
export function makeToolsSpyCtx(): PluginContext & {
  calls: Array<{ messages: unknown; model?: string; tools?: unknown }>
} {
  const calls: Array<{ messages: unknown; model?: string; tools?: unknown }> = []
  const ctx: PluginContext & {
    calls: Array<{ messages: unknown; model?: string; tools?: unknown }>
  } = {
    config: {},
    calls,
    client: {
      session: {
        message: async (args: Record<string, unknown>) => {
          calls.push({
            messages: args.messages,
            model: args.model as string | undefined,
            tools: args.tools,
          })
          // Minimal valid response shape (info+structured+finalText all optional)
          return {
            info: { tokens: { input: 0, output: 0 } },
            content: [{ type: "text", text: "spy" }],
            finalText: "spy",
          }
        },
      },
    },
  }
  return ctx
}