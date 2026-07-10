// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// MCP bridge for workflow scripts — barrel re-export.
//
// Workflows run inside a quickjs-emscripten WASM sandbox with no Node.js /
// Web surface. To call MCP tools, the script has TWO mechanisms:
//   1) `tools: "INHERIT"` on `agent()` opts — the parent's tool list is
//      forwarded to the LLM so any tool_use is dispatched via the parent SDK.
//   2) The `mcp.*` host functions (`mcp.list()`, `mcp.call(name, args)`)
//      injected as guest globals so a script can invoke an MCP tool DIRECTLY
//      without round-tripping through an LLM (per MiMo design w5-6 §6).
//
// All logic lives in the sibling mcp-* modules. This barrel re-exports the
// public surface so existing call sites (`import { McpBridge } from "./mcp.ts"`)
// keep working without any churn.

export {
  DEFAULT_MAX_MCP_CALLS,
  type McpCallRecord,
  type ToolWhitelist,
  type ResolvedTools,
} from "./mcp-types.ts"

export { discoverParentTools, resolveInheritedTools } from "./mcp-resolver.ts"

export { McpBridge, makeMcpPrimitives } from "./mcp-bridge.ts"