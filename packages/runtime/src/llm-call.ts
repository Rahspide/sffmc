// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import type { AgentOptions, InternalRunEntry, PluginContext } from "./types.ts"
import { resolveInheritedTools } from "./mcp.ts"

/** Return shape for `callLLM`. Mirrors the OpenCode `client.session.message`
 *  response — we narrow it to what runtime consumers actually read. */
export interface CallLLMResult {
  content: Array<{ type: string; text?: string; data?: string }>
  info?: { tokens?: { input?: number; output?: number } }
  structured?: unknown
  finalText?: string
}

/** Dispatch a single LLM call from a workflow step. The result is passed
 *  back to the runtime to update counters / events. No LLM client → a
 *  deterministic placeholder result is returned so the workflow can proceed
 *  (downstream code expects a non-null result; the "no LLM" case is logged
 *  in the runtime layer if it matters).
 *
 *  Pure over `ctx` (no `this`). Lifted out of `WorkflowRuntime` per v0.16.0
 *  refactor plan; the runtime class delegates here. */
export async function callLLM(
  ctx: PluginContext,
  _entry: InternalRunEntry,
  prompt: string,
  opts: AgentOptions,
): Promise<CallLLMResult> {
  // Build messages
  const systemPrompt = opts.schema
    ? `You are a workflow step. Output valid JSON matching the requested schema.`
    : `You are a workflow step. Output your result directly.`

  const messages: Array<{ role: string; content: string }> = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ]

  // Resolve `tools: "INHERIT"` against the parent MCP tool set BEFORE the
  // SDK call. Three cases:
  //   - undefined → forward literal "INHERIT" (legacy default; SDK resolves)
  //   - array → shallow-copy and forward (do NOT mutate caller's array)
  //   - "INHERIT" → discover parent tools; if discovery surface missing,
  //     fall back to the literal so the SDK still resolves it correctly.
  // The MCP bridge lives in mcp.ts; this module only wires the call.
  const resolvedTools = await resolveInheritedTools(opts.tools, ctx)

  // Use ctx.client.session.message() — bypasses Max Mode + tool.execute hooks
  if ((ctx as { client?: { session?: { message?: Function } } }).client?.session?.message) {
    return (ctx as {
      client: { session: { message: (args: unknown) => Promise<CallLLMResult> } }
    }).client.session.message({
      messages,
      model: opts.model,
      tools: resolvedTools,
    })
  }

  // Fallback: no LLM client available — return empty
  return { content: [{ type: "text", text: "workflow: no LLM client available" }] }
}
