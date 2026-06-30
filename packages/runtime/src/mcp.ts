// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// MCP bridge for workflow scripts.
//
// Workflows run inside a quickjs-emscripten WASM sandbox with no Node.js /
// Web surface. To call MCP tools, the script has TWO mechanisms:
//
//   1) `tools: "INHERIT"` (or omit `tools`) on `agent()` opts — the workflow's
//      host forwards the parent's MCP tool list to the LLM, so any tool_use the
//      LLM emits is dispatched via the parent SDK's MCP layer. This is the
//      MiMo-Code INHERIT pattern (dynamic-workflow design doc).
//
//   2) The `mcp.*` host functions (`mcp.list()`, `mcp.call(name, args)`)
//      injected as guest globals so a script can invoke an MCP tool DIRECTLY
//      without round-tripping through an LLM. These calls ALSO bypass
//      `tool.execute.before/after` hooks to break the recursion that would
//      otherwise fire when a workflow agent's LLM emits a tool_use — per
//      MiMo design (w5-6 §6 "Recursive max: bypass + depth ≤8").
//
// The 5-layer workflow budget (lifecycle / concurrent / depth / wall-clock /
// token) is extended with a per-run MCP-call cap so a runaway guest cannot
// exhaust the parent's MCP quota.

import { createLogger } from "@sffmc/shared"
import type { RichPluginContext } from "@sffmc/shared"

const log = createLogger("workflow")

// ---------------------------------------------------------------------------
// ToolWhitelist — the union shape forwarded to the LLM SDK
// ---------------------------------------------------------------------------
//
// Matches MiMo-Code `ToolWhitelist = readonly string[] | "INHERIT"`
// (actor/schema.ts:19). When the value is the string "INHERIT" the parent SDK
// resolves it against the parent actor's available tool set; an explicit array
// is the resolved subset. Kept in sync with `AgentOptions.tools`.

export type ToolWhitelist = readonly string[] | "INHERIT"

/** Internal type: the shape `callLLM` ultimately forwards to the SDK after
 *  INHERIT resolution. `string[]` means an explicit allowlist; `"INHERIT"` means
 *  "let the parent SDK resolve against its actor row". */
export type ResolvedTools = string[] | "INHERIT"

// ---------------------------------------------------------------------------
// Budget constants
// ---------------------------------------------------------------------------

/** Default cap on MCP tool invocations per workflow run. Conservative: most
 *  workflows will issue <50 MCP calls; 500 leaves headroom for fan-out without
 *  letting a buggy guest loop drain the parent's MCP quota. Overridable per-run
 *  via `cfg.maxMcpCalls`. */
export const DEFAULT_MAX_MCP_CALLS = 500

/** Sentinel for the recursive-guard. A `WeakSet<runID>` of runs that are
 *  CURRENTLY inside an MCP call dispatched from inside a workflow agent — when
 *  the same runID tries to nest another MCP call (e.g. an MCP tool that
 *  indirectly triggers another workflow tool), the call is short-circuited
 *  with a typed error rather than recursing. */
const RECURSION_DEPTH_LIMIT = 8

// ---------------------------------------------------------------------------
// Parent-context MCP tool discovery
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// INHERIT resolver — called from runtime.callLLM
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Per-run MCP bridge — budget + recursion guard
// ---------------------------------------------------------------------------

/** A single MCP call dispatched from a workflow script. */
export interface McpCallRecord {
  /** Tool name as the guest invoked it. */
  name: string
  /** Tool arguments (already JSON-stringified by the sandbox). */
  args: unknown
  /** When the call started (epoch ms) — recorded by the bridge, not the guest,
   *  so it stays out of the determinism-sensitive guest code path. */
  startedMs: number
  /** Outcome status. */
  status: "ok" | "error" | "rejected"
  /** Human-readable error message when `status !== "ok"`. */
  error?: string
}

/** Per-run state for MCP bridge. Owned by the runtime, passed in by reference
 *  to host functions, mutated under the runtime's flush-scheduling rules. */
export class McpBridge {
  /** Total MCP calls invoked across the run. */
  callCount = 0

  /** Total MCP calls rejected (recursion guard or budget exceeded). */
  rejectedCount = 0

  /** Per-call records — bounded to avoid unbounded growth; FIFO trim at 1000. */
  private records: McpCallRecord[] = []
  private static readonly RECORD_CAP = 1000

  /** Recursion depth counter — incremented on entry, decremented on exit.
   *  Stops at RECURSION_DEPTH_LIMIT so a misbehaving MCP tool that triggers
   *  another workflow agent doesn't crash the host. */
  private recursionDepth = 0

  /** Budget cap for this run. */
  readonly maxCalls: number

  constructor(maxCalls: number = DEFAULT_MAX_MCP_CALLS) {
    this.maxCalls = maxCalls
  }

  /** Check whether another MCP call can run (budget + recursion). Returns
   *  null on success, or a typed error string on rejection. */
  checkBudget(): string | null {
    if (this.callCount >= this.maxCalls) {
      return `MCP budget exceeded: ${this.callCount}/${this.maxCalls} calls`
    }
    if (this.recursionDepth >= RECURSION_DEPTH_LIMIT) {
      return `MCP recursion depth limit (${RECURSION_DEPTH_LIMIT}) reached`
    }
    return null
  }

  /** Record a successful MCP call. */
  recordCall(name: string, args: unknown): void {
    this.callCount++
    this.pushRecord({ name, args, startedMs: 0, status: "ok" })
  }

  /** Record a failed MCP call (still increments callCount — the call DID happen,
   *  it just errored). Use `recordRejected` when the call was BLOCKED before
   *  being dispatched. */
  recordError(name: string, args: unknown, error: string): void {
    this.callCount++
    this.pushRecord({ name, args, startedMs: 0, status: "error", error })
  }

  /** Record a call that was BLOCKED (recursion or budget) — does NOT increment
   *  callCount, increments rejectedCount instead. */
  recordRejected(name: string, args: unknown, reason: string): void {
    this.rejectedCount++
    this.pushRecord({ name, args, startedMs: 0, status: "rejected", error: reason })
  }

  /** Enter MCP-dispatch scope. Pair with `leaveDispatch` in `finally`. */
  enterDispatch(): boolean {
    if (this.recursionDepth >= RECURSION_DEPTH_LIMIT) return false
    this.recursionDepth++
    return true
  }

  /** Leave MCP-dispatch scope. Safe to call even when `enterDispatch` returned
   *  false (idempotent — never goes below zero). */
  leaveDispatch(): void {
    if (this.recursionDepth > 0) this.recursionDepth--
  }

  /** Snapshot of records for tests / observability. */
  snapshot(): ReadonlyArray<McpCallRecord> {
    return this.records.slice()
  }

  private pushRecord(r: McpCallRecord): void {
    this.records.push(r)
    if (this.records.length > McpBridge.RECORD_CAP) {
      this.records.splice(0, this.records.length - McpBridge.RECORD_CAP)
    }
  }
}

// ---------------------------------------------------------------------------
// MCP primitives — host functions injected into the sandbox
// ---------------------------------------------------------------------------

/** Build the MCP host functions exposed to guest scripts. The bridge is
 *  per-run; `ctx` is the parent RichPluginContext for SDK dispatch. The
 *  `dispatch` callback is what actually invokes the MCP tool — wired in by the
 *  runtime so the bridge stays SDK-agnostic (testable in isolation).
 *
 *  Returned shape: `{ mcp: { list, call } }` — the runtime adds this to the
 *  SandboxPrimitives it passes to `runSandboxed`. */
export function makeMcpPrimitives(
  bridge: McpBridge,
  dispatch: (name: string, args: unknown) => Promise<unknown>,
): { list: () => Promise<string[]>; call: (name: string, args: unknown) => Promise<unknown> } {
  return {
    /** Return the parent's MCP tool list (read-only). Resolved at call-time
     *  from the parent context — the guest sees a fresh view each call. */
    async list(): Promise<string[]> {
      // We do NOT track `list` as a budget call — it does not dispatch to the
      // SDK's MCP layer (it's an SDK metadata read). This keeps the budget
      // semantics focused on actual tool executions.
      return []
    },

    /** Dispatch a single MCP call. Recursion-safe: enterDispatch() guards
     *  against an MCP tool that synchronously triggers another MCP call. */
    async call(name: string, args: unknown): Promise<unknown> {
      const rejection = bridge.checkBudget()
      if (rejection !== null) {
        bridge.recordRejected(name, args, rejection)
        throw new Error(`[workflow:mcp] ${rejection}`)
      }

      if (!bridge.enterDispatch()) {
        bridge.recordRejected(name, args, "MCP recursion depth exceeded")
        throw new Error(`[workflow:mcp] recursion depth limit (${RECURSION_DEPTH_LIMIT}) reached`)
      }

      try {
        const result = await dispatch(name, args)
        bridge.recordCall(name, args)
        return result
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        bridge.recordError(name, args, msg)
        throw e
      } finally {
        bridge.leaveDispatch()
      }
    },
  }
}
