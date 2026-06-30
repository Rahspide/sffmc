// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { WorkflowRuntime, type RuntimeOpts } from "./runtime.ts"
import { createWorkflowTool } from "./tool.ts"
import type { PluginContext } from "./runtime.ts"
import type { WorkflowAgentFailedEvent, WorkflowFinishedEvent } from "./events.ts"
import { createLogger, loadConfig } from "@sffmc/shared";
import { DEFAULT_WORKFLOW_CONFIG } from "./types.ts";

const log = createLogger("workflow")

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

export { DEFAULT_WORKFLOW_CONFIG } from "./types.ts"
export { DEFAULT_GRACE_PERIOD_MS, DEFAULT_SANDBOX_CONSTRAINTS, MAX_GRACE_PERIOD_MS } from "./constants.ts"
export { WorkflowPersistence } from "./persistence.ts"
export { parseMeta } from "./meta.ts"
export { resolveWorkflow, isInlineScript } from "./resolve.ts"
export { registerBuiltin, getBuiltin, loadBuiltin, listBuiltins } from "./builtin-registry.ts"
export { createEventBus, WorkflowEventEmitter } from "./events.ts"
export { createWorkflowTool } from "./tool.ts"
export { WorkflowRuntime, type RuntimeOpts } from "./runtime.ts"

export const id = "@sffmc/runtime"
export const server = async (ctx: PluginContext) => {
  // workflow recovery grace period — load user YAML config (gracePeriodMs + other workflow limits)
  // once at startup. The runtime reads `this.gracePeriodMs` directly so
  // `recoverOrphanedWorkflows()` can be called synchronously without
  // hitting disk. Tests inject via `RuntimeOpts.gracePeriodMsOverride`
  // to avoid the YAML round-trip.
  const cfg = await loadConfig<typeof DEFAULT_WORKFLOW_CONFIG>("workflow", DEFAULT_WORKFLOW_CONFIG)

  const runtime = new WorkflowRuntime(ctx)
  try {
    runtime.setGracePeriodMs(cfg.gracePeriodMs)
  } catch (err) {
    log.warn(`workflow: invalid gracePeriodMs=${cfg.gracePeriodMs} — using default ${DEFAULT_WORKFLOW_CONFIG.gracePeriodMs}:`, err)
  }
  const tool = createWorkflowTool(runtime)

  // Register observability listeners on the runtime's event bus
  runtime.events.on("workflow:agent_failed", (e) => {
    const ev = e as WorkflowAgentFailedEvent
    log.warn(`agent ${ev.agentKey} in ${ev.runID} failed: ${ev.reason}`)
  })

  runtime.events.on("workflow:finished", (e) => {
    const ev = e as WorkflowFinishedEvent
    if (ev.status !== "completed") {
      log.warn(`${ev.runID} finished: ${ev.status}${ev.error ? ` — ${ev.error}` : ""}`)
    }
  })

  return {
    config: async (_cfg: unknown) => {
      // Recover orphaned workflows on startup
      await runtime.recoverOrphanedWorkflows()
    },
    tool: {
      workflow: tool,
    },
    // Optional: hook into chat to suggest workflows for long-running tasks
    // Deferred to Lane D.
  }
}

export default { id, server }
