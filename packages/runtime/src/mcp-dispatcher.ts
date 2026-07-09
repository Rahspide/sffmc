// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// MCP tool dispatch, extracted from WorkflowRuntime per the v0.16.0
// refactor plan (ora-7, Phase 4). The runtime holds a reference to
// an `McpDispatcher` instance and delegates `dispatchMcpList` /
// `dispatchMcpCall` to it, preserving the call-site shape while
// moving the implementation into a focused module.
//
// Why a class (not free functions): the two methods share a single
// dependency (ctx) and form a small bounded operation surface
// (list tools, call a tool). Bundling them makes the dependency
// graph explicit and unit-testable in isolation.

import { discoverParentTools } from "./mcp.ts"
import type { IMcpDispatcher } from "./runtime-services.ts"
import type { PluginContext } from "./types.ts"
import type { InternalRunEntry } from "./internal-run-entry.ts"

export interface McpDispatcherDeps {
  /** Lazy getter for the OpenCode plugin context. Lazy because the
   *  ctx.client.session.message surface can be mutated at runtime
   *  by tests; reading it at call time is correct. */
  getCtx: () => PluginContext
}

export class McpDispatcher implements IMcpDispatcher {
  constructor(private readonly deps: McpDispatcherDeps) {}

  /** List the MCP tools available in the parent OpenCode context.
   *  Returns an empty array when discovery returns no tools or when
   *  the parent SDK is missing the discovery surface. */
  async list(entry: InternalRunEntry): Promise<string[]> {
    const discovered = await discoverParentTools(this.deps.getCtx())
    return discovered ?? []
  }

  /** Dispatch a single MCP tool call through the parent SDK. Enforces
   *  two guards before the SDK call:
   *  1. **Budget gate** — per-run cap on MCP calls (bridge.checkBudget)
   *  2. **Recursion guard** — short-circuit if a misbehaving MCP tool
   *     triggers another workflow/MCP call before the SDK roundtrip
   *     (bridge.enterDispatch)
   *  Records the attempt on the happy path and on failure (so the
   *  budget reflects real SDK load, not just successes). */
  async call(
    entry: InternalRunEntry,
    name: string,
    args: unknown,
  ): Promise<unknown> {
    const bridge = entry.mcpBridge

    // Budget gate (lifecycle cap of MCP calls per run).
    const budgetReject = bridge.checkBudget()
    if (budgetReject !== null) {
      bridge.recordRejected(name, args, budgetReject)
      throw new Error(`[workflow:mcp] ${budgetReject}`)
    }

    // Recursion guard — a misbehaving MCP tool that triggers another
    // workflow agent (or another MCP call) is short-circuited before the
    // SDK dispatch rather than after.
    if (!bridge.enterDispatch()) {
      bridge.recordRejected(name, args, "MCP recursion depth exceeded")
      throw new Error(`[workflow:mcp] recursion depth limit exceeded`)
    }

    try {
      // Dispatch through parent SDK. `ctx.client.tool.call` is the OpenCode
      // convention. When the surface is absent we fail closed with a typed
      // error — the bridge still records the attempt for observability.
      const tool = (this.deps.getCtx().client as { tool?: { call?: (n: string, a: unknown) => Promise<unknown> } } | undefined)?.tool
      if (!tool?.call) {
        bridge.recordError(name, args, "no MCP SDK surface available")
        throw new Error(`[workflow:mcp] no MCP SDK surface available on ctx.client.tool.call`)
      }

      const result = await tool.call(name, args)
      bridge.recordCall(name, args)
      return result
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // recordCall already incremented callCount on the happy path; on a
      // failed SDK call we still want it counted as "attempted" so budget
      // reflects real SDK load, not just successes.
      if (!msg.includes("no MCP SDK surface")) {
        bridge.recordError(name, args, msg)
      }
      throw e
    } finally {
      bridge.leaveDispatch()
    }
  }
}
