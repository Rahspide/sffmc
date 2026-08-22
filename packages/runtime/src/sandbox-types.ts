// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Sandbox type definitions extracted from sandbox.ts to break the
// type-only import cycle (sandbox-prelude.ts -> sandbox.ts ->
// sandbox-prelude.ts). This leaf module has NO imports from sandbox.ts
// or sandbox-prelude.ts; both files import `SandboxPrimitives` from
// here. Resulting direction: sandbox-types.ts <- sandbox-prelude.ts <-
// sandbox.ts (acyclic).

import type { JsonValue } from "./runs.ts"

/** The full set of primitives available inside the sandbox. The set
 *  is closed at the QuickJS boundary — every function here is
 *  marshaled through JSON-compatible types (the `JsonValue` union
 *  narrows what scripts can pass across the host/guest bridge). */
export interface SandboxPrimitives {
  agent: (task: string, opts?: JsonValue) => Promise<JsonValue>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T>(items: T[], ...stages: Array<(acc: JsonValue, item: T, i: number) => Promise<JsonValue>>) => Promise<Array<JsonValue>>
  workflow: (nameOrScript: string, args?: JsonValue) => Promise<JsonValue>
  phase: (title: string) => void
  log: (msg: string) => void
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, content: string) => Promise<void>
  glob: (pattern: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  /** Host-injected: list the parent's available MCP tool names. */
  mcpList: () => Promise<string[]>
  /** Host-injected: dispatch a single MCP tool call. */
  mcpCall: (name: string, args: JsonValue) => Promise<JsonValue>
  args: JsonValue // injected by value
}
