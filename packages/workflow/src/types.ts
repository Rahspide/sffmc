// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { SCRIPT_DEADLINE_MS } from "./constants.ts"

/** Status of a workflow run. */
export type WorkflowStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "crashed"
  | "budget_exceeded"

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
}

export const DEFAULT_WORKFLOW_CONFIG: WorkflowConfig = {
  maxSteps: 200,
  maxTokens: 2_000_000,
  maxWallClockMs: 3_600_000, // 1 hour
  perStepTimeoutMs: 120_000, // 2 minutes
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

/** Options passed to agent() inside a workflow script. */
export interface AgentOptions {
  model?: string
  tools?: readonly string[]
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
