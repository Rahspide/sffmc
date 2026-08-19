// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import * as v from "valibot"

/** `ctx.config` — the per-plugin key/value bag passed via `ctx.config`.
 *  OpenCode hands plugins a `Record<string, unknown>`; we narrow to the
 *  documented scalar fields and let plugin-specific code (e.g. safety
 *  `rules:`) carry its own schema rather than baking it in here. */
export const PluginConfigSchema = v.object({
  model: v.optional(v.string()),
})

/** `ctx.config` type derived from the schema. */
export type PluginConfig = v.InferOutput<typeof PluginConfigSchema>

/**
 * Args accepted by `ctx.client.session.message()`. Mirrors what callers
 * (max-mode judge, dream LLM, workflow llm-call) actually pass — the SDK
 * may accept more, but we narrow to the contract we rely on.
 */
export const MessageInputSchema = v.object({
  messages: v.array(
    v.object({
      role: v.union([v.literal("system"), v.literal("user"), v.literal("assistant")]),
      content: v.string(),
    }),
  ),
  model: v.optional(v.string()),
  temperature: v.optional(v.number()),
  tools: v.optional(v.union([v.array(v.string()), v.literal("INHERIT")])),
})

export type MessageInput = v.InferOutput<typeof MessageInputSchema>

/**
 * Response shape from `ctx.client.session.message()`. Narrowed to the
 * fields runtime consumers actually read (content parts, token counts).
 */
export const MessageOutputSchema = v.object({
  content: v.array(
    v.object({
      type: v.string(),
      text: v.optional(v.string()),
    }),
  ),
  info: v.optional(
    v.object({
      tokens: v.optional(
        v.object({
          input: v.optional(v.number()),
          output: v.optional(v.number()),
        }),
      ),
    }),
  ),
})

export type MessageOutput = v.InferOutput<typeof MessageOutputSchema>

export type SessionMessageFn = (args: MessageInput) => Promise<MessageOutput>

/**
 * Plugin context — boundary type passed by OpenCode to every `server()`.
 * The runtime shape is `{ projectRoot, config, [key]: unknown }`; we
 * replace the open index signature with the documented fields, plus the
 * optional client/usage pair RichPluginContext adds below.
 *
 * The config field is the parsed, schema-narrowed shape — callers that
 * need plugin-specific keys should look them up against the plugin's own
 * schema, not against this open dict.
 */
export interface PluginContext {
  projectRoot: string
  config: PluginConfig
  client?: {
    session?: {
      message?: SessionMessageFn
    }
  }
  usage?: { totalTokens?: number }
}

/**
 * Rich plugin context — extends PluginContext with optional OpenCode client + usage fields.
 * Used by max-mode and workflow which need `client.session.message()` and `usage.totalTokens`.
 *
 * The `message` input/output is now schema-narrowed (see MessageInputSchema / MessageOutputSchema);
 * callers should treat the schema as the contract and `v.parse` external payloads before insertion.
 */
export type RichPluginContext = PluginContext
