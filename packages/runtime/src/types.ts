// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { DEFAULT_GRACE_PERIOD_MS, SCRIPT_DEADLINE_MS, WORKFLOW_LIMITS } from "./constants.ts"
import type { OutcomeStore } from "./outcome-store.ts"

/** Status of a workflow run. Const-object pattern (mirrors
 *  `AgentFailureReason` at types.ts:135-143) so producers and consumers
 *  reference the same identifier. Renaming a member here is a compile
 *  error at every call site — eliminating the magic-string coupling that
 *  previously existed between `failRun()` and the budget-exceeded
 *  classifier (gen-11 F-2.1). */
export const WorkflowStatus = {
  Running: "running",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
  Crashed: "crashed",
  /** Recoverable state — has journal to replay, distinct from crashed. */
  Paused: "paused",
  BudgetExceeded: "budget_exceeded",
} as const

export type WorkflowStatus = (typeof WorkflowStatus)[keyof typeof WorkflowStatus]

/** Typed exception signalling token-budget exhaustion. Raised by
 *  `AgentPrimitive` when total token usage crosses the configured cap;
 *  caught by `RunCompleter.failRun()` via `instanceof` and routed to
 *  `WorkflowStatus.BudgetExceeded`. Replaces the prior magic-string
 *  classifier (`error.includes("budget_exceeded")`) which silently
 *  broke if anyone renamed the type's `"budget_exceeded"` member. */
export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BudgetExceededError"
    Object.setPrototypeOf(this, BudgetExceededError.prototype)
  }
}

/** Row in the workflow_runs SQLite table. */
export interface WorkflowRun {
  runID: string
  /** Human-readable label (from meta.name). */
  name: string
  status: WorkflowStatus
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  parentRunID?: string
  args?: unknown
  /** SHA-256 of the workflow script body, for resume edit detection. */
  scriptSha?: string
  /** Per-agent timeout for this run (ms). Persisted so resume picks same value. */
  agentTimeoutMs?: number
  error?: string
  /** v0.13.0 — lexical jail root persisted across resume() so a crashed
   *  workflow resumes in the same directory it was started in. */
  workspace?: string
  createdAt: number
  updatedAt: number
}

/** Row in the workflow_steps SQLite table. */
export interface WorkflowStep {
  runID: string
  stepIndex: number
  kind: "agent" | "log" | "phase" | "child_workflow"
  input?: string
  output?: string
  costTokens: number
  durationMs: number
  error?: string
  timestamp: number
}

/** A journal event persisted to the JSONL journal file. */
export type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "log"; msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }

/** In-memory state for a live workflow run. */
export interface RunEntry {
  promise: Promise<unknown>
  controller: AbortController
  started: number
  runID: string
  status: WorkflowStatus
  agentCount: number
  succeeded: number
  failed: number
  currentPhase?: string
  childRunIDs: Set<string>
}

/** Configuration for a workflow launch. */
export interface WorkflowConfig {
  /** Maximum agents over the entire run lifecycle. Default: 200. */
  maxSteps: number
  /** Maximum total tokens across all agents. Default: 2_000_000. */
  maxTokens: number
  /** Wall-clock deadline for the entire script (ms). Default: 3_600_000 (1h). */
  maxWallClockMs: number
  /** Default per-agent timeout (ms). Default: 120_000 (2 min). */
  perStepTimeoutMs: number
  /** Grace period (ms) for `recoverOrphanedWorkflows()`. Runs with
   *  status='running' and age ≤ gracePeriodMs are marked 'paused' (resumable);
   *  runs past grace without a journal are marked 'crashed' (not resumable).
   *  Default: 300_000 (5 min). Cap: 24h. */
  gracePeriodMs: number
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  ...WORKFLOW_LIMITS,
  gracePeriodMs: DEFAULT_GRACE_PERIOD_MS,
}

/** Constraints for the sandbox execution environment. */
export interface SandboxConstraints {
  memoryMB: number
  /** Maximum number of instructions (QuickJS interrupt counter). */
  maxInstructions: number
  /** Wall-clock deadline for the sandbox (ms). */
  deadlineMs: number
  /** PRNG seed for deterministic replay. */
  seed?: number
}

// DEFAULT_SANDBOX_CONSTRAINTS moved to ./constants.ts (breaks types<->runtime cycle)

/** Tool whitelist for an agent call. The string literal `"INHERIT"` resolves
 *  against the parent OpenCode session's available MCP tools (the MiMo-Code
 *  INHERIT pattern — dynamic-workflow design doc); an array pins the agent to
 *  an explicit subset. See `mcp.ts` `ToolWhitelist`. */
export type ToolWhitelist = readonly string[] | "INHERIT"

/** Options passed to agent() inside a workflow script. */
export interface AgentOptions {
  model?: string
  /** When omitted, defaults to `"INHERIT"` (parent's MCP tool set forwarded to
   *  the LLM). When an array, the agent is pinned to that explicit subset.
   *  When the literal string `"INHERIT"`, the runtime resolves the parent's
   *  MCP tools via `mcp.resolveInheritedTools()` before forwarding. */
  tools?: ToolWhitelist
  schema?: Record<string, unknown>
  isolation?: "worktree"
  label?: string
  phase?: string
  timeoutMs?: number
  /** Nesting depth. Default: 8. */
  depth?: number
}

/** Result from an agent() call. null = failure, string = final text, object = structured output. */
export type AgentResult = null | string | object

/** Why an agent() call resolved to null. */
export const AgentFailureReason = {
  OverCap: "over-cap",
  SpawnReject: "spawn-reject",
  Timeout: "timeout",
  ActorError: "actor-error",
  NoDeliverable: "no-deliverable",
} as const

export type AgentFailureReason = (typeof AgentFailureReason)[keyof typeof AgentFailureReason]

/** Input for the workflow_start LLM tool. */
export interface WorkflowStartInput {
  file?: string
  script?: string
  args?: unknown
  workspace?: string
  agentTimeoutMs?: number
}

/** Current state returned by workflow_status. */
export interface WorkflowStatusOutput {
  runID: string
  status: WorkflowStatus
  agentCount: number
  succeeded: number
  failed: number
  currentPhase?: string
  stepsCompleted: number
  stepsTotal: number
  tokensUsed: number
  error?: string
}

/** Final outcome returned by workflow_wait or workflow_status when done. */
export interface WorkflowOutcome {
  runID: string
  status: "completed" | "failed" | "cancelled" | "crashed" | "budget_exceeded"
  result?: unknown
  error?: string
  stepsCompleted: number
  stepsTotal: number
  tokensUsed: number
  durationMs: number
}

/** Typed `OutcomeStore` for workflow outcomes — the runtime's private
 *  field and any test code that needs to construct or cast an outcome
 *  cache both use this alias instead of re-spelling the generic
 *  parameters at every call site (gen-11 F-2.7). The `OutcomeStore`
 *  class itself stays generic (`<K, V>`) so other domains can keep
 *  custom key/value shapes. */
export type WorkflowOutcomeStore = OutcomeStore<string, WorkflowOutcome>

/** Error class for workflow-level failures. */
export class WorkflowError extends Error {
  stepsCompleted: number
  stepsTotal: number
  tokensUsed: number

  constructor(
    message: string,
    stepsCompleted: number,
    stepsTotal: number,
    tokensUsed: number,
  ) {
    super(message)
    this.name = "WorkflowError"
    this.stepsCompleted = stepsCompleted
    this.stepsTotal = stepsTotal
    this.tokensUsed = tokensUsed
  }
}
