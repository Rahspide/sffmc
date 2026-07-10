// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE
//
// MCP bridge for workflow scripts — barrel re-exporting the focused
// sub-modules. Public API is preserved exactly.
//
// Module map:
//   ./mcp-types.ts    — types, constants
//   ./mcp-resolver.ts — INHERIT resolver (discoverParentTools, resolveInheritedTools)
//   ./mcp-bridge.ts   — McpBridge class + makeMcpPrimitives host-side wrappers

export {
  DEFAULT_MAX_MCP_CALLS,
  type McpCallRecord,
  type ResolvedTools,
  type ToolWhitelist,
} from "./mcp-types.ts"
export { McpBridge, makeMcpPrimitives } from "./mcp-bridge.ts"
export { discoverParentTools, resolveInheritedTools } from "./mcp-resolver.ts"
