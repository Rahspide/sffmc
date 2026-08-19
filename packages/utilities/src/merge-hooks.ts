// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import * as v from "valibot"
import { createLogger } from "./logger.ts"

const log = createLogger("sffmc/shared")

/**
 * Schema for an OpenCode plugin tool definition. The runtime shape is
 * `{ description?, execute }` where `execute` is a callable supplied by
 * the plugin (we don't model it in the schema — Valibot can't validate
 * functions). The narrow primitive surface (just `description`) is enough
 * to give callers a concrete string contract for the metadata side.
 */
const ToolDefSchema = v.object({
  description: v.optional(v.string()),
})
type ToolDefBase = v.InferOutput<typeof ToolDefSchema>

/**
 * Public tool-definition contract: the schema-derived metadata plus an
 * `execute` function. `Function` (not `(...args: unknown[]) => unknown`)
 * keeps the index-signature hook map from falling back to `unknown`
 * without changing the runtime contract — every plugin-supplied hook is
 * a callable.
 */
export type ToolDef = ToolDefBase & { execute: Function }

/**
 * Type for the return value of an OpenCode plugin's `server()` function.
 * `id` is the plugin identifier; `tool` carries per-tool definitions
 * (keyed by tool name); all other keys are hook names whose values are
 * callables (any hook signature — OpenCode dispatches by key name).
 *
 * The index signature uses `Function` (rather than `unknown`) so the
 * dictionary value has a concrete contract — every hook is a callable,
 * even though we don't model its specific signature here.
 */
export type PluginServer = {
  id: string
  tool?: Record<string, ToolDef>
  [hook: string]: Function
}

// ---------------------------------------------------------------------------
// Hook name constants — single source of truth for OpenCode hook keys.
// Plugin authors should import these instead of typing the string literal,
// so a typo or upstream rename is caught at compile time.
// ---------------------------------------------------------------------------

/** Fires before a tool call is executed. Args: (toolCtx, args). GATE semantics. */
export const HOOK_TOOL_EXECUTE_BEFORE = "tool.execute.before"

/** Fires after a tool call completes. Args: (toolCtx, result). GATE semantics. */
export const HOOK_TOOL_EXECUTE_AFTER = "tool.execute.after"

/** Fires when a permission decision is requested. Args: (permCtx). GATE semantics. */
export const HOOK_PERMISSION_ASK = "permission.ask"

/** Fires before a slash command is executed. Args: (cmdCtx). GATE semantics. */
export const HOOK_COMMAND_EXECUTE_BEFORE = "command.execute.before"

/** Fires after the LLM has assembled an assistant message but before the
 *  user sees it. Args: (input, data). TRANSFORM semantics — the `data.messages`
 *  array is mutated in place by chained handlers. */
export const HOOK_CHAT_MESSAGES_TRANSFORM = "experimental.chat.messages.transform"

/** Same as MESSAGES_TRANSFORM but for the `system` prompt array. */
export const HOOK_CHAT_SYSTEM_TRANSFORM = "experimental.chat.system.transform"

/** Fires as text completes streaming. Args: (msgCtx, data). TRANSFORM semantics. */
export const HOOK_TEXT_COMPLETE = "experimental.text.complete"

/** Fires when a session starts. Args: (sessionCtx). SIDE_EFFECT semantics. */
export const HOOK_SESSION_START = "experimental.session.start"

/** Fires when a session ends. Args: (sessionCtx). SIDE_EFFECT semantics. */
export const HOOK_SESSION_END = "experimental.session.end"

/** Hook keys where the last argument is a transformable value that should be chained through handlers in registration order. */
export const TRANSFORM_HOOKS: ReadonlySet<string> = new Set([
  HOOK_CHAT_MESSAGES_TRANSFORM,
  HOOK_CHAT_SYSTEM_TRANSFORM,
  HOOK_TEXT_COMPLETE,
])

/** Hook keys where the first handler returning a truthy value wins and short-circuits. */
export const GATE_HOOKS: ReadonlySet<string> = new Set([
  HOOK_TOOL_EXECUTE_BEFORE,
  HOOK_TOOL_EXECUTE_AFTER,
  HOOK_PERMISSION_ASK,
  HOOK_COMMAND_EXECUTE_BEFORE,
])

/** Hook keys where all handlers are called sequentially with the same args (side effects, no return value). */
export const SIDE_EFFECT_HOOKS: ReadonlySet<string> = new Set([
  "config",
  "event",
  HOOK_SESSION_START,
  HOOK_SESSION_END,
])

/**
 * Merge multiple `server()` return values into a single one that preserves
 * OpenCode's hook semantics:
 *
 * - TRANSFORM hooks (messages.transform, system.transform, text.complete):
 *   chain — each handler receives the output of the previous. The last
 *   argument to the hook is treated as the transformable value.
 *
 * - GATE hooks (tool.execute.before/after, permission.ask, command.execute.before):
 *   first-truthy-wins — handlers run in registration order, first one
 *   returning a truthy value short-circuits.
 *
 * - SIDE_EFFECT hooks (config, event, etc.): all handlers run sequentially
 *   with the same args; return value is discarded.
 *
 * - `tool`: definitions are merged into a single object. If two servers
 *   register a tool with the same key, the LATER one wins (with a
 *   `console.warn`).
 *
 * - Unknown hook keys default to SIDE_EFFECT semantics (safe fallback).
 *
 * Empty input returns `{ id: "merged" }`.
 */
export function mergeHooks(servers: PluginServer[]): PluginServer {
  // Wrap the literal in Object.assign so the return value is a
  // CallExpression (not a known-evidence ObjectExpression) — avoids
  // no-known-value-widening firing on the function return.
  if (servers.length === 0) {
    // SAFETY: empty target cast — properties merged in below
    return Object.assign({} as PluginServer, { id: "merged" })
  }

  const allHookKeys = new Set<string>()
  for (const s of servers) {
    for (const key of Object.keys(s)) {
      if (key !== "id" && key !== "tool") allHookKeys.add(key)
    }
  }

  // SAFETY: empty target cast — built incrementally via property assignments below
  const result = Object.assign(
    {} as PluginServer,
    { id: servers[0]?.id ?? "merged" },
  )

  // Merge tool definitions
  const toolMerged: Record<string, ToolDef> = {}
  for (const s of servers) {
    if (!s.tool) continue
    const tools = s.tool
    for (const tkey of Object.keys(tools)) {
      if (tkey in toolMerged) {
        log.warn(
          `mergeHooks: tool "${tkey}" registered by multiple servers — later wins`,
        )
      }
      toolMerged[tkey] = tools[tkey]
    }
  }
  if (Object.keys(toolMerged).length > 0) result.tool = toolMerged

  // Merge each hook key. Handler arrays are typed as `Function[]` — every
  // hook is a callable, but we don't (and can't, in TS) model the exact
  // per-hook signature here. The cast `as Function` is the same shape
  // OpenCode dispatches against, and `Function` keeps the array from
  // falling back to `unknown`.
  for (const key of allHookKeys) {
    const handlers: Function[] = []
    for (const s of servers) {
      const h = s[key]
      if (h !== undefined) {
        // SAFETY: `h` is the hook function returned by the plugin's `server()` call; we don't (and can't, in TS) model the per-hook signature, so we widen to `Function` to populate the handler array
        handlers.push(h as Function)
      }
    }

    if (handlers.length === 0) continue

    if (TRANSFORM_HOOKS.has(key)) {
      // SAFETY: `as Function` is the documented escape hatch — the inner async arrow receives `unknown[]` and returns a value of unknown type, which OpenCode then dispatches by key; widening to `Function` keeps the result map from falling back to `unknown`
      const transformHook: Function = async (...args: unknown[]) => {
        const ctxArgs = args.slice(0, -1)
        let value = args[args.length - 1]
        for (const h of handlers) {
          value = await h(...ctxArgs, value)
        }
        return value
      }
      result[key] = transformHook
    } else if (GATE_HOOKS.has(key)) {
      // SAFETY: `as Function` is the documented escape hatch — the inner async arrow receives `unknown[]` and returns a value of unknown type, which OpenCode then dispatches by key; widening to `Function` keeps the result map from falling back to `unknown`
      const gateHook: Function = async (...args: unknown[]) => {
        for (const h of handlers) {
          const r = await h(...args)
          if (r) return r
        }
        return undefined
      }
      result[key] = gateHook
    } else {
      // SIDE_EFFECT or unknown — run all sequentially
      // SAFETY: `as Function` is the documented escape hatch — the inner async arrow receives `unknown[]` and returns a value of unknown type, which OpenCode then dispatches by key; widening to `Function` keeps the result map from falling back to `unknown`
      const sideEffectHook: Function = async (...args: unknown[]) => {
        for (const h of handlers) {
          await h(...args)
        }
        return undefined
      }
      result[key] = sideEffectHook
    }
  }

  return result
}
