// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import { createLogger } from "./logger.ts"

const log = createLogger("sffmc/shared")

/**
 * Type for the return value of an OpenCode plugin's `server()` function.
 * `id` is the plugin identifier; all other keys are hook names.
 */
export type PluginServer = {
  id: string;
  tool?: Record<string, unknown>;
  [hook: string]: unknown;
};

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
]);

/** Hook keys where the first handler returning a truthy value wins and short-circuits. */
export const GATE_HOOKS: ReadonlySet<string> = new Set([
  HOOK_TOOL_EXECUTE_BEFORE,
  HOOK_TOOL_EXECUTE_AFTER,
  HOOK_PERMISSION_ASK,
  HOOK_COMMAND_EXECUTE_BEFORE,
]);

/** Hook keys where all handlers are called sequentially with the same args (side effects, no return value). */
export const SIDE_EFFECT_HOOKS: ReadonlySet<string> = new Set([
  "config",
  "event",
  HOOK_SESSION_START,
  HOOK_SESSION_END,
]);

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
  if (servers.length === 0) return { id: "merged" };

  const allHookKeys = new Set<string>();
  for (const s of servers) {
    for (const key of Object.keys(s)) {
      if (key !== "id" && key !== "tool") allHookKeys.add(key);
    }
  }

  const result: PluginServer = { id: servers[0]?.id ?? "merged" };

  // Merge tool definitions
  const toolMerged: Record<string, unknown> = {};
  for (const s of servers) {
    if (!s.tool) continue;
    const tools = s.tool as Record<string, unknown>;
    for (const tkey of Object.keys(tools)) {
      if (tkey in toolMerged) {
        log.warn(
          `mergeHooks: tool "${tkey}" registered by multiple servers — later wins`,
        );
      }
      toolMerged[tkey] = tools[tkey];
    }
  }
  if (Object.keys(toolMerged).length > 0) result.tool = toolMerged;

  // Merge each hook key
  for (const key of allHookKeys) {
    const handlers: Array<(...args: unknown[]) => unknown> = [];
    for (const s of servers) {
      const h = s[key];
      if (h !== undefined) handlers.push(h as (...args: unknown[]) => unknown);
    }

    if (handlers.length === 0) continue;

    if (TRANSFORM_HOOKS.has(key)) {
      result[key] = async (...args: unknown[]) => {
        const ctxArgs = args.slice(0, -1);
        let value = args[args.length - 1];
        for (const h of handlers) {
          value = await h(...ctxArgs, value);
        }
        return value;
      };
    } else if (GATE_HOOKS.has(key)) {
      result[key] = async (...args: unknown[]) => {
        for (const h of handlers) {
          const r = await h(...args);
          if (r) return r;
        }
        return undefined;
      };
    } else {
      // SIDE_EFFECT or unknown — run all sequentially
      result[key] = async (...args: unknown[]) => {
        for (const h of handlers) {
          await h(...args);
        }
        return undefined;
      };
    }
  }

  return result;
}
