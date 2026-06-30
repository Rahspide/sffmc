// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Re-export from types.ts
export type { AgentOptions, AgentResult, AgentFailureReason, WorkflowConfig } from "./types.ts"

// ---------------------------------------------------------------------------
// Primitive signatures
// ---------------------------------------------------------------------------

/** Run one LLM agent. NEVER throws — resolves to null on any failure. */
export interface AgentFn {
  (prompt: string, opts?: import("./types.ts").AgentOptions): Promise<import("./types.ts").AgentResult>
}

/** Run thunks concurrently. Does NOT catch — throws bubble via Promise.all. */
export interface ParallelFn {
  <T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
}

/** Stream items through stages. No barrier between stages. Does NOT catch. */
export interface PipelineFn {
  <T>(items: T[], ...stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>): Promise<Array<unknown>>
}
