// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Types + constants shared across the MCP sub-modules.
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

/** Default cap on MCP tool invocations per workflow run. Conservative: most
 *  workflows will issue <50 MCP calls; 500 leaves headroom for fan-out without
 *  letting a buggy guest loop drain the parent's MCP quota. Overridable per-run
 *  via `cfg.maxMcpCalls`. */
export const DEFAULT_MAX_MCP_CALLS = 500

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