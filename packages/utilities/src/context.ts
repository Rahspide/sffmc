// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

export interface PluginContext {
  projectRoot: string
  config: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Rich plugin context — extends PluginContext with optional OpenCode client + usage fields.
 * Used by max-mode and workflow which need `client.session.message()` and `usage.totalTokens`.
 *
 * The `message` return type is deliberately loose (Record<string, unknown>) because
 * different consumers access different response shapes (content, parts, usage, info, etc.).
 */
export type RichPluginContext = PluginContext & {
  client?: {
    session?: {
      message?: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
    }
  }
  usage?: { totalTokens?: number }
}
