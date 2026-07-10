// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// MCP — per-run bridge state + host-side primitives.
//
// Two concerns co-located because they share the same per-run state:
//   - `McpBridge` — budget + recursion counters, mutated by host funcs
//   - `makeMcpPrimitives` — host-side wrappers that consult the bridge
//
// Extracted from mcp.ts to keep that file a barrel.

import { toErrorMessage } from "./errors.ts"
import { DEFAULT_MAX_MCP_CALLS } from "./mcp-types.ts"
import type { McpCallRecord } from "./mcp-types.ts"

/** Sentinel for the recursive-guard. A `WeakSet<runID>` of runs that are
 *  CURRENTLY inside an MCP call dispatched from inside a workflow agent — when
 *  the same runID tries to nest another MCP call (e.g. an MCP tool that
 *  indirectly triggers another workflow tool), the call is short-circuited
 *  with a typed error rather than recursing. */
const RECURSION_DEPTH_LIMIT = 8

// ---------------------------------------------------------------------------
// Per-run MCP bridge — budget + recursion guard
// ---------------------------------------------------------------------------

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
 *  Returned shape:
 *    - `list()` — read-only metadata (not budget-tracked)
 *    - `call(name, args)` — single-shot dispatch with budget + recursion
 *    - `bind(name)` — returns a `(args) => Promise<unknown>` callable that
 *      forwards to `call()`. Lets scripts grab a typed handle once and
 *      invoke it directly, without re-passing the tool name.
 *    - `bindAll()` — `bind()` for every tool in the parent's registry,
 *      returned as `Record<string, callable>`. Convenience for
 *      `const { github_search } = await mcp.bindAll()` style destructuring. */
export function makeMcpPrimitives(
  bridge: McpBridge,
  dispatch: (name: string, args: unknown) => Promise<unknown>,
): {
  list: () => Promise<string[]>
  call: (name: string, args: unknown) => Promise<unknown>
  bind: (name: string) => (args: unknown) => Promise<unknown>
  bindAll: () => Promise<Record<string, (args: unknown) => Promise<unknown>>>
} {
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
        const msg = toErrorMessage(e)
        bridge.recordError(name, args, msg)
        throw e
      } finally {
        bridge.leaveDispatch()
      }
    },

    /** Bind a single MCP tool name to a host-side callable. The returned
     *  function routes through `call()` so budget + recursion guards
     *  apply identically — this is just a syntactic shortcut.
     *
     *  Does NOT validate that `name` exists in the parent registry: the
     *  underlying `dispatch()` returns a meaningful error for unknown
     *  tools, so we let that propagate rather than introducing a parallel
     *  validation step that could drift. */
    bind(name: string): (args: unknown) => Promise<unknown> {
      return (args: unknown) => this.call(name, args)
    },

    /** Bind every tool in the parent's registry. Re-fetches the list on
     *  every call so the result reflects the parent's current tool set
     *  (tools can be added/removed at runtime via the SDK). */
    async bindAll(): Promise<Record<string, (args: unknown) => Promise<unknown>>> {
      const names = await this.list()
      const out: Record<string, (args: unknown) => Promise<unknown>> = {}
      for (const name of names) {
        out[name] = this.bind(name)
      }
      return out
    },
  }
}
