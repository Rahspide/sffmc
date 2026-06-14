// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import { getRuntime } from "./runtime-ref.ts"

// ---------------------------------------------------------------------------
// Manual discriminated union validation (no zod dep)
// ---------------------------------------------------------------------------

type WorkflowToolArgs =
  | { operation: "run"; name?: string; script?: string; args?: unknown; workspace?: string }
  | { operation: "status"; run_id: string }
  | { operation: "wait"; run_id: string; timeout_ms?: number }
  | { operation: "cancel"; run_id: string }
  | { operation: "resume"; run_id: string; agent_timeout_ms?: number }

function validateArgs(args: unknown): WorkflowToolArgs {
  if (typeof args !== "object" || args === null) {
    throw new Error("workflow tool args must be an object")
  }
  const a = args as Record<string, unknown>
  const op = a.operation
  if (typeof op !== "string") {
    throw new Error(`workflow tool requires "operation" field (run|status|wait|cancel|resume)`)
  }

  switch (op) {
    case "run": {
      const name = typeof a.name === "string" && a.name ? a.name : undefined
      const script = typeof a.script === "string" && a.script ? a.script : undefined
      if (!name && !script) {
        throw new Error("workflow run: provide either `name` or `script`")
      }
      if (name && script) {
        throw new Error("workflow run: provide either `name` or `script`, not both")
      }
      return {
        operation: "run",
        name,
        script,
        args: a.args,
        workspace: typeof a.workspace === "string" ? a.workspace : undefined,
      }
    }
    case "status": {
      if (typeof a.run_id !== "string" || !a.run_id) {
        throw new Error("workflow status: `run_id` is required")
      }
      return { operation: "status", run_id: a.run_id }
    }
    case "wait": {
      if (typeof a.run_id !== "string" || !a.run_id) {
        throw new Error("workflow wait: `run_id` is required")
      }
      return {
        operation: "wait",
        run_id: a.run_id,
        timeout_ms: typeof a.timeout_ms === "number" ? a.timeout_ms : undefined,
      }
    }
    case "cancel": {
      if (typeof a.run_id !== "string" || !a.run_id) {
        throw new Error("workflow cancel: `run_id` is required")
      }
      return { operation: "cancel", run_id: a.run_id }
    }
    case "resume": {
      if (typeof a.run_id !== "string" || !a.run_id) {
        throw new Error("workflow resume: `run_id` is required")
      }
      return {
        operation: "resume",
        run_id: a.run_id,
        agent_timeout_ms: typeof a.agent_timeout_ms === "number" ? a.agent_timeout_ms : undefined,
      }
    }
    default:
      throw new Error(
        `unknown workflow operation: ${JSON.stringify(op)}. Valid: run, status, wait, cancel, resume`,
      )
  }
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const workflowTool = {
  name: "workflow",
  description: `Run, monitor, and resume multi-step orchestrated workflows. Use this for tasks with 5+ sequential steps or any fan-out (parallel) work that needs to be durable across the LLM session.

5 operations:
- run: start a new workflow. Provide either a saved name (from .sffmc/workflows/ or .claude/workflows/), inline script (with export const meta), or file path to a .ts script.
- status: poll progress. Returns steps completed, last output, elapsed time.
- wait: block until completion (or timeout). Use when you want to wait for the workflow before continuing.
- cancel: stop a running workflow.
- resume: resume a crashed/cancelled workflow from last checkpoint.

NEVER use this for single-step tasks — direct agent calls are faster and cheaper.

If script is provided, it MUST start with: \`export const meta = { name, description, whenToUse, phases: [...] }\`

Examples:
  workflow({ operation: "run", name: "deep-research", args: { question: "..." } })
  workflow({ operation: "status", run_id: "wf_abc123" })
  workflow({ operation: "wait", run_id: "wf_abc123", timeout_ms: 60000 })
`,

  // Schema for LLM tool registration (JSON Schema format)
  parameters: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["run", "status", "wait", "cancel", "resume"],
        description: "Which operation to perform",
      },
      name: {
        type: "string",
        description: "Name of a built-in or saved workflow to run (EITHER name OR script, not both)",
      },
      script: {
        type: "string",
        description: "Inline JS workflow script (EITHER name OR script, not both)",
      },
      args: {
        description: "JSON value exposed to the script as `args`",
      },
      workspace: {
        type: "string",
        description: "Absolute dir the script's file primitives are jailed to",
      },
      run_id: {
        type: "string",
        description: "Workflow run ID (wf_...) for status/wait/cancel/resume",
      },
      timeout_ms: {
        type: "number",
        description: "Max milliseconds to wait before returning",
      },
      agent_timeout_ms: {
        type: "number",
        description: "Per-agent timeout for resumed run (ms)",
      },
    },
    required: ["operation"],
  },

  execute: async (args: unknown, _ctx?: unknown): Promise<string> => {
    const runtime = getRuntime()
    if (!runtime) {
      return "Error: workflow runtime not initialized. The @sffmc/workflow plugin must be loaded."
    }

    try {
      const validated = validateArgs(args)
      switch (validated.operation) {
        case "run": {
          const startInput = {
            name: validated.name,
            script: validated.script,
            args: validated.args,
            workspace: validated.workspace,
            sessionID: "tool-call",
          } as Parameters<typeof runtime.start>[0]
          return JSON.stringify(await runtime.start(startInput))
        }
        case "status":
          return JSON.stringify(await runtime.status({ runID: validated.run_id }))
        case "wait":
          return JSON.stringify(await runtime.wait({ runID: validated.run_id, timeoutMs: validated.timeout_ms }))
        case "cancel":
          await runtime.cancel({ runID: validated.run_id })
          return JSON.stringify({ cancelled: validated.run_id })
        case "resume":
          return JSON.stringify(await runtime.resume({ runID: validated.run_id, agentTimeoutMs: validated.agent_timeout_ms }))
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`
    }
  },
} as const
