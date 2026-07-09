// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Runtime service interfaces (SOLID, Dependency Inversion Principle).
//
// Per the v0.16.0-SOLID extension, the `WorkflowRuntime` orchestrator
// accepts a `RuntimeServices` container holding the 4 sub-components
// it delegates to. The default construction is inline in
// `runtime.ts` (the orchestrator constructor builds each
// sub-component); tests pass mocks via `opts.services`.
//
// `WorkflowPersistence`, `FlushManager`, `RuntimeConfig`, `OutcomeStore`,
// `WorkflowEventEmitter`, `WorkflowActivation`, and `Concurrency` are
// NOT in the container — they're plain per-runtime fields on
// `WorkflowRuntime`. None of the production code paths route through
// a container for them, and including them in the interface invited
// silent-override bugs (a partial override would not update the
// local field). They remain testable via reflection on the runtime.
//
// SOLID mapping:
//   - S (Single Responsibility) — services are the 4 sub-components
//     that delegate work; plain fields hold the orchestrator's own state.
//   - I (Interface Segregation) — each sub-component interface
//     describes only the methods the orchestrator calls.
//   - D (Dependency Inversion) — `WorkflowRuntime` depends on these
//     sub-component abstractions, not on the concrete classes.

import type { InternalRunEntry } from "./internal-run-entry.ts"
import type { AgentFailureReason, AgentOptions, AgentResult } from "./types.ts"
import type { WorkspaceJail } from "./workspace.ts"

// ---------------------------------------------------------------------------
// Sub-component interfaces (SOLID, Interface Segregation Principle).
//
// Each sub-component exposes a narrow interface describing only the
// methods the `WorkflowRuntime` orchestrator actually calls. Tests
// can mock any sub-component by satisfying the interface; the
// concrete class implementations live in their own files and `implements`
// their interface (compile-time check).
// ---------------------------------------------------------------------------

/** Narrow surface of `RunCompleter` that the orchestrator uses. */
export interface IRunCompleter {
  completeRun(entry: InternalRunEntry, result?: unknown): void
  failRun(entry: InternalRunEntry, error: string | Error): void
  settleEntry(
    entry: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    jail: WorkspaceJail,
  ): Promise<void>
}

/** Narrow surface of `McpDispatcher` that the orchestrator uses. */
export interface IMcpDispatcher {
  list(entry: InternalRunEntry): Promise<string[]>
  call(entry: InternalRunEntry, name: string, args: unknown): Promise<unknown>
}

/** Narrow surface of `AgentPrimitive` that the orchestrator uses. */
export interface IAgentPrimitive {
  spawnAgent(
    entry: InternalRunEntry,
    task: string,
    opts: AgentOptions | undefined,
    occ: Map<string, number>,
  ): Promise<AgentResult>
  executeAgentCall(
    entry: InternalRunEntry,
    promptStr: string,
    agentOpts: AgentOptions,
    key: string,
  ): Promise<AgentResult | null>
  runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
  runPipeline<T>(
    items: T[],
    stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>,
  ): Promise<Array<unknown>>
  publishAgentFailed(
    runID: string,
    agentKey: string,
    reason: AgentFailureReason,
  ): void
}

/** Narrow surface of `ChildWorkflowPrimitive` that the orchestrator uses. */
export interface IChildWorkflowPrimitive {
  spawn(
    entry: InternalRunEntry,
    nameOrScript: string,
    childArgs: unknown,
    occ: Map<string, number>,
  ): Promise<unknown>
  setPhase(entry: InternalRunEntry, title: string): void
  appendLog(entry: InternalRunEntry, msg: string): void
  start(
    parent: InternalRunEntry,
    script: string,
    name: string,
    args: unknown,
    childRunID: string,
  ): Promise<InternalRunEntry>
}

/** Sub-components container — the 4 sub-components the orchestrator
 *  delegates to via narrow interfaces. Tests can override one or more
 *  by passing `opts.services`. Production callers omit the opt and
 *  get the real implementations. */
export interface RuntimeServices {
  runCompleter: IRunCompleter
  mcpDispatcher: IMcpDispatcher
  agentPrimitive: IAgentPrimitive
  childWorkflowPrimitive: IChildWorkflowPrimitive
}