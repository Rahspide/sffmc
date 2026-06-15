// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/**
 * Type for the return value of an OpenCode plugin's `server()` function.
 * `id` is the plugin identifier; all other keys are hook names.
 */
export type PluginServer = {
  id: string;
  tool?: Record<string, unknown>;
  [hook: string]: unknown;
};

/** Hook keys where the last argument is a transformable value that should be chained through handlers in registration order. */
export const TRANSFORM_HOOKS: ReadonlySet<string> = new Set([
  "experimental.chat.messages.transform",
  "experimental.chat.system.transform",
  "experimental.text.complete",
]);

/** Hook keys where the first handler returning a truthy value wins and short-circuits. */
export const GATE_HOOKS: ReadonlySet<string> = new Set([
  "tool.execute.before",
  "tool.execute.after",
  "permission.ask",
  "command.execute.before",
]);

/** Hook keys where all handlers are called sequentially with the same args (side effects, no return value). */
export const SIDE_EFFECT_HOOKS: ReadonlySet<string> = new Set([
  "config",
  "event",
  "experimental.session.start",
  "experimental.session.end",
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
        console.warn(
          `[@sffmc/shared] mergeHooks: tool "${tkey}" registered by multiple servers — later wins`,
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
