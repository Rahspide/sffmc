// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// InternalRunEntry + factory — extracted from WorkflowRuntime (M-1 god-object
// refactor, Task 1.6 façade reduction). The runtime previously held the
// `InternalRunEntry` interface (lines 149-180 of the pre-extract runtime.ts)
// and the `makeEntry()` factory (lines 1229-1261) inline. The interface and
// factory are pure data-construction concerns and don't depend on any
// runtime instance state, so they move cleanly to a separate module.
//
// Why both in one file: the interface and its factory are tightly coupled —
// the factory's job is to populate every required interface field, and
// drift between the two creates subtle bugs (a field added to the interface
// must also be initialized in the factory). Keeping them co-located makes
// that contract obvious at a glance.
//
// Why a factory and not just `new InternalRunEntry()`: the factory sets up
// the deferred-outcome promise pair (outcomePromise + resolveOutcome) and
// seeds the counters, journal Maps, and AbortController that runtime code
// expects to find on every entry. Constructing the entry literal at every
// call site inlines 12 lines per site and risks field drift.
//
// Reflection-test compatibility: `runtime-coverage.test.ts`,
// `spawn-child-coverage.test.ts`, and `lru-cache.test.ts` build fake entries
// via literal object expressions that satisfy the `InternalRunEntry`
// contract. Because the interface is structural (no `class` keyword), those
// literals remain valid as long as the interface shape is unchanged. Tests
// also use `Record<string, unknown>` casts, so missing fields are tolerated.

import { CounterManager } from "./counter-manager.ts"
import { McpBridge, DEFAULT_MAX_MCP_CALLS } from "./mcp.ts"
import type {
  WorkflowConfig,
  WorkflowOutcome,
  WorkflowStatus,
} from "./types.ts"

/** Per-run activation record. Holds counter state (via CounterManager), the
 *  deferred outcome promise pair, and the MCP bridge. Workflows are
 *  registered into the `WorkflowActivation` registry on `start()` /
 *  `resume()` / `startChildWorkflow()` and removed on settle so the heavy
 *  fields (mcpBridge, journalResults, AbortController, closures) are
 *  GC-eligible (v0.14.x C-2). */
export interface InternalRunEntry {
  runID: string
  name: string
  status: WorkflowStatus
  counters: CounterManager
  capWarned: boolean
  currentPhase?: string
  childRunIDs: Set<string>
  startedMs: number
  deadlineMs: number
  outcomePromise: Promise<WorkflowOutcome>
  resolveOutcome: (outcome: WorkflowOutcome) => void
  controller: AbortController
  journalResults: Map<string, unknown>
  journalPass: number
  cfg: Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number }
  workspace?: string
  mcpBridge: McpBridge
}

export interface MakeEntryOpts {
  runID: string
  name: string
  cfg: Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number }
  journalResults?: Map<string, unknown>
  journalPass?: number
  workspace?: string
}

/** Build a fresh `InternalRunEntry`. Each call wires a new deferred-outcome
 *  promise pair (so concurrent `wait(runID)` resolves when settle runs),
 *  zero-initialized counter state, and an isolated McpBridge so concurrent
 *  runs don't share MCP budget. */
export function makeEntry(opts: MakeEntryOpts): InternalRunEntry {
  const startedMs = Date.now()
  let resolveOutcome!: (outcome: WorkflowOutcome) => void
  const outcomePromise = new Promise<WorkflowOutcome>((res) => { resolveOutcome = res })
  return {
    runID: opts.runID,
    name: opts.name,
    status: "running",
    counters: new CounterManager(),
    capWarned: false,
    childRunIDs: new Set(),
    startedMs,
    deadlineMs: startedMs + opts.cfg.maxWallClockMs,
    outcomePromise,
    resolveOutcome,
    controller: new AbortController(),
    journalResults: opts.journalResults ?? new Map(),
    journalPass: opts.journalPass ?? 0,
    cfg: opts.cfg,
    workspace: opts.workspace,
    mcpBridge: new McpBridge(DEFAULT_MAX_MCP_CALLS),
  }
}

/** Construct a `WorkflowOutcome` snapshot from a settled entry. Pulls
 *  `stepsCompleted` / `stepsTotal` / `tokensUsed` from the entry's counter
 *  state + config, and `durationMs` from the wall-clock since the entry was
 *  started. Used by `completeRun()` / `failRun()` / `cancel()` so the three
 *  settle paths shape their outcomes uniformly. */
export function outcomeFor(
  entry: InternalRunEntry,
  status: WorkflowOutcome["status"],
  extras?: { result?: unknown; error?: string },
): WorkflowOutcome {
  return {
    runID: entry.runID,
    status,
    result: extras?.result,
    error: extras?.error,
    stepsCompleted: entry.counters.succeeded + entry.counters.failed,
    stepsTotal: entry.cfg.maxSteps,
    tokensUsed: entry.counters.tokensUsed,
    durationMs: Date.now() - entry.startedMs,
  }
}
