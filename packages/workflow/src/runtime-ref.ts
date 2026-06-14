// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Late-bound reference to the WorkflowRuntime service implementation.
// The workflow tool (Lane C) reads this ref at call time to invoke
// start/status/wait/cancel/resume without importing runtime.ts directly.
// Paths that never use the workflow tool simply leave `current` undefined.
//
// This breaks the circular import: tool.ts → runtime-ref.ts ← runtime.ts
// (runtime.ts sets the ref on init, tool.ts reads it at call time).

import type { WorkflowStartInput, WorkflowOutcome, WorkflowStatusOutput, WorkflowStatus } from "./types.ts"

export interface WorkflowRuntime {
  start(input: WorkflowStartInput & { sessionID: string }): Promise<{ runID: string }>
  status(input: { runID: string }): Promise<WorkflowStatusOutput>
  wait(input: { runID: string; timeoutMs?: number }): Promise<WorkflowOutcome>
  cancel(input: { runID: string }): Promise<void>
  resume(input: { runID: string; agentTimeoutMs?: number }): Promise<{ runID: string; resumed: boolean }>
  list(): Promise<Array<{ runID: string; name: string; status: WorkflowStatus }>>
}

const ref: { current: WorkflowRuntime | undefined } = { current: undefined }

export function getRuntime(): WorkflowRuntime | undefined {
  return ref.current
}

export function setRuntime(runtime: WorkflowRuntime): void {
  ref.current = runtime
}
