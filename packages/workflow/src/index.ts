// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { WorkflowRuntime } from "./runtime.ts"
import { setRuntime } from "./runtime-ref.ts"
import { workflowTool } from "./tool.ts"
import { on } from "./events.ts"
import type { WorkflowRuntime as RuntimeRef } from "./runtime-ref.ts"
import type { PluginContext } from "./runtime.ts"

// Re-export types for consumers
export type {
  WorkflowStatus,
  WorkflowRun,
  WorkflowStep,
  JournalEvent,
  RunEntry,
  WorkflowConfig,
  SandboxConstraints,
  AgentOptions,
  AgentResult,
  AgentFailureReason,
  WorkflowStartInput,
  WorkflowStatusOutput,
  WorkflowOutcome,
  WorkflowError,
} from "./types.ts"

export { DEFAULT_WORKFLOW_CONFIG, DEFAULT_SANDBOX_CONSTRAINTS } from "./types.ts"
export { WorkflowPersistence } from "./persistence.ts"
export { parseMeta } from "./meta.ts"
export { resolveWorkflow, isInlineScript } from "./resolve.ts"
export { getRuntime, setRuntime } from "./runtime-ref.ts"
export { registerBuiltin, getBuiltin, loadBuiltin, listBuiltins } from "./builtin-registry.ts"
export { on, off, emit, clearAll } from "./events.ts"
export { workflowTool } from "./tool.ts"
export { WorkflowRuntime } from "./runtime.ts"

export default {
  id: "@sffmc/workflow",
  server: async (ctx: PluginContext) => {
    const runtime = new WorkflowRuntime(ctx)
    setRuntime(runtime as RuntimeRef)

    // Register observability listeners
    on("workflow:agent_failed", (e) => {
      const ev = e as import("./events.ts").WorkflowAgentFailedEvent
      console.warn(`[workflow] agent ${ev.agentKey} in ${ev.runID} failed: ${ev.reason}`)
    })

    on("workflow:finished", (e) => {
      const ev = e as import("./events.ts").WorkflowFinishedEvent
      if (ev.status !== "completed") {
        console.warn(`[workflow] ${ev.runID} finished: ${ev.status}${ev.error ? ` — ${ev.error}` : ""}`)
      }
    })

    return {
      config: async (_cfg: unknown) => {
        // Recover orphaned workflows on startup
        await runtime.recoverOrphanedWorkflows()
      },
      tool: {
        workflow: workflowTool,
      },
      // Optional: hook into chat to suggest workflows for long-running tasks
      // Deferred to Lane D.
    }
  },
}
