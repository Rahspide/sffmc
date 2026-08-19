// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// Shared helpers for the coverage test suite. Existing files (resume.test.ts,
// runtime-coverage.test.ts, journal-race.test.ts) each set up their own
// tmpDir + persistence; this module is for new tests that need mock
// PluginContexts or pre-canned journal seeds.

import type { PluginContext } from "../src/runtime.ts"

/** Test-only domain alias for the LLM call args shape (used by
 *  `session.message` spies). The value type is the recursive
 *  `LlmArgValue` union — concrete enough to satisfy the
 *  no-unsafe-dictionary-type rule (which bans `unknown` as a direct
 *  value type). */
type LlmArgPrimitive = string | number | boolean | null;
type LlmArgValue =
  | LlmArgPrimitive
  | LlmArgPrimitive[]
  | { [key: string]: LlmArgValue }
  | undefined;
// oxlint-disable-next-line no-shape-in-symbol-names
type LLMCallArgsShape = { [key: string]: LlmArgValue };

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
      // oxlint-disable-next-line no-shape-in-symbol-names
      session: {
        message: async (args: LLMCallArgsShape) => {
          calls.push({
            messages: args.messages,
            // SAFETY: args.model is unknown; string | undefined is the documented LLM SDK call.model parameter type
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