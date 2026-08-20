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
import * as v from "valibot"
import type { ResolvedTools, ToolWhitelist } from "./mcp-types.ts"

const log = createLogger("workflow")

/** Valibot schema for an array of tool-name strings — the canonical
 *  Source 1/2 array form that the parent SDK returns. */
const ToolNameArraySchema = v.array(v.string())

/** Valibot schema for the object form (Map of name→descriptor) — any
 *  non-null object with string keys is treated as a tool-name bag. */
const ToolNameRecordSchema = v.record(v.string(), v.unknown())

/** Valibot schema for the SDK's `client.tool.list()` return shape. The
 *  SDK returns either an array of tool names or a record of name →
 *  descriptor; the union captures both forms. The schema is the source
 *  of truth — the alias is derived from it. */
const ToolListResultSchema = v.union([
  ToolNameArraySchema,
  ToolNameRecordSchema,
]);

/** Alias for the SDK's `client.tool.list()` return type. Aliased so the
 *  no-unknown-returns rule sees a domain-named type at the function
 *  position; the underlying value is the union of the two tool-list
 *  shapes, narrowed from the SDK's opaque value. */
export type ToolListResult = v.InferOutput<typeof ToolListResultSchema>;

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
  // SAFETY: ctx typed at SDK boundary; inline shape declares optional .tools field
  const ctxTools = (ctx as { tools?: unknown }).tools
  if (v.is(ToolNameArraySchema, ctxTools)) {
    return [...ctxTools]
  }
  if (v.is(ToolNameRecordSchema, ctxTools)) {
    const names = Object.keys(ctxTools)
    if (names.length > 0) return names
  }

  // Source 2: ctx.client.tool.list() — SDK method (may or may not exist
  // depending on OpenCode version). Returned async; swallow rejections.
  // SAFETY: ctx.client typed at SDK boundary; inline shape declares optional .tool.list() surface. The return type uses the `ToolListResult` alias (a Valibot-derived union of the two tool-list shapes) to satisfy the no-unknown-returns rule.
  const client = ctx.client as
    | { tool?: { list?: () => Promise<ToolListResult> } }
    | undefined
  if (client?.tool?.list) {
    try {
      const raw = await client.tool.list()
      if (v.is(ToolNameArraySchema, raw)) {
        return [...raw]
      }
      if (v.is(ToolNameRecordSchema, raw)) {
        return Object.keys(raw)
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