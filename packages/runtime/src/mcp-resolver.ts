// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Parent-context MCP tool discovery + INHERIT resolver.
//
// Extracted from mcp.ts so the two related pure functions live in one focused
// module. `discoverParentTools` reads the parent OpenCode session's MCP
// surface (3 sources in priority order); `resolveInheritedTools` is the
// runtime-side helper that `callLLM` calls when forwarding opts.tools.
//
// Both functions are pure (no shared state) and SDK-agnostic — they operate on
// the `RichPluginContext` shape exposed by `@sffmc/utilities`.

import { createLogger, type RichPluginContext } from "@sffmc/utilities"
import type { ResolvedTools, ToolWhitelist } from "./mcp-types.ts"

const log = createLogger("workflow")

/** Discover the MCP tool set the parent OpenCode session currently exposes.
 *  Three sources, in priority order:
 *   1) `ctx.tools` — array of tool descriptors / names (preferred)
 *   2) `ctx.client.tool.list()` — async SDK method (if available)
 *   3) null — parent has no MCP surface; INHERIT falls through to the SDK
 *      which will resolve against its actor row (or fail at SDK level).
 *
 *  Returns the resolved array of tool names, or null when no discovery
 *  surface is available. `null` is distinct from `[]` — the latter means
 *  the parent explicitly has no MCP tools; null means "unknown, defer to SDK". */
export async function discoverParentTools(
  ctx: RichPluginContext,
): Promise<string[] | null> {
  // Source 1: ctx.tools — pre-resolved list (preferred path).
  const ctxTools = (ctx as { tools?: unknown }).tools
  if (Array.isArray(ctxTools)) {
    return ctxTools.filter((t): t is string => typeof t === "string")
  }
  // Object form (Map of name→descriptor) — extract names.
  if (ctxTools && typeof ctxTools === "object") {
    const names = Object.keys(ctxTools as Record<string, unknown>)
    if (names.length > 0) return names
  }

  // Source 2: ctx.client.tool.list() — SDK method (may or may not exist
  // depending on OpenCode version). Returned async; swallow rejections.
  const client = ctx.client as
    | { tool?: { list?: () => Promise<unknown> } }
    | undefined
  if (client?.tool?.list) {
    try {
      const raw = await client.tool.list()
      if (Array.isArray(raw)) {
        return raw.filter((t): t is string => typeof t === "string")
      }
      if (raw && typeof raw === "object") {
        return Object.keys(raw as Record<string, unknown>)
      }
    } catch (e) {
      log.debug("ctx.client.tool.list() failed; falling back:", e)
    }
  }

  // Source 3: defer to parent SDK (the `"INHERIT"` literal is what the SDK
  // itself recognizes — see actor/schema.ts:19 in MiMo-Code).
  return null
}

/** Resolve `opts.tools === "INHERIT"` against the parent context.
 *  Returns either a concrete `string[]` (the discovered tools) or the literal
 *  `"INHERIT"` sentinel when no discovery surface is available (the SDK
 *  resolves it itself).
 *
 *  When `opts.tools` is an array, returns a shallow copy (so callers can
 *  freely mutate without surprising the workflow script). */
export async function resolveInheritedTools(
  optsTools: ToolWhitelist | undefined,
  ctx: RichPluginContext,
): Promise<ResolvedTools> {
  // undefined → keep the existing "no caller preference" path: the SDK
  // receives the literal "INHERIT" sentinel (same as before MCP integration).
  if (optsTools === undefined) return "INHERIT"

  // Explicit array → forward a shallow copy.
  if (Array.isArray(optsTools)) return [...optsTools]

  // Literal "INHERIT" → try to resolve against parent context.
  const discovered = await discoverParentTools(ctx)
  if (discovered === null) return "INHERIT" // parent surface unknown → let SDK resolve
  return discovered
}