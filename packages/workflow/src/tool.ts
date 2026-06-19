// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import type { WorkflowRuntime } from "./runtime.ts"
import { WORKFLOW_SEARCH_DIRS } from "./constants.ts"

// ---------------------------------------------------------------------------
// Discriminated union type for compile-time validation
// ---------------------------------------------------------------------------

type WorkflowToolArgs =
  | { operation: "run"; name?: string; script?: string; args?: unknown; workspace?: string }
  | { operation: "status"; run_id: string }
  | { operation: "wait"; run_id: string; timeout_ms?: number }
  | { operation: "cancel"; run_id: string }
  | { operation: "resume"; run_id: string; agent_timeout_ms?: number }

// ---------------------------------------------------------------------------
// Tool factory — creates a tool object closed over the runtime instance
// ---------------------------------------------------------------------------

export function createWorkflowTool(runtime: WorkflowRuntime) {
  return {
    description: `Run, monitor, and resume multi-step orchestrated workflows. Use this for tasks with 5+ sequential steps or any fan-out (parallel) work that needs to be durable across the LLM session.

5 operations:
- run: start a new workflow. Provide either a saved name (from one of: ${WORKFLOW_SEARCH_DIRS.map((d) => `\`${d}/\``).join(", ")}), inline script (with export const meta), or file path to a .ts script.
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
          description: "JSON value exposed to the script as \`args\`",
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

    execute: async (args: WorkflowToolArgs, _ctx?: unknown): Promise<string> => {
      // Quick runtime guard — LLM may send malformed args despite schema
      if (typeof args !== "object" || args === null || typeof (args as Record<string, unknown>).operation !== "string") {
        return "Error: workflow tool requires 'operation' field (run|status|wait|cancel|resume)"
      }

      try {
        switch (args.operation) {
          case "run": {
            if (!args.name && !args.script) {
              return "Error: workflow run: provide either \`name\` or \`script\`"
            }
            if (args.name && args.script) {
              return "Error: workflow run: provide either \`name\` or \`script\`, not both"
            }
            const startInput = {
              name: args.name,
              script: args.script,
              args: args.args,
              workspace: args.workspace,
              sessionID: "tool-call",
            } as Parameters<typeof runtime.start>[0]
            return JSON.stringify(await runtime.start(startInput))
          }
          case "status": {
            if (!args.run_id) {
              return "Error: workflow status: \`run_id\` is required"
            }
            return JSON.stringify(await runtime.status({ runID: args.run_id }))
          }
          case "wait": {
            if (!args.run_id) {
              return "Error: workflow wait: \`run_id\` is required"
            }
            return JSON.stringify(await runtime.wait({ runID: args.run_id, timeoutMs: args.timeout_ms }))
          }
          case "cancel": {
            if (!args.run_id) {
              return "Error: workflow cancel: \`run_id\` is required"
            }
            await runtime.cancel({ runID: args.run_id })
            return JSON.stringify({ cancelled: args.run_id })
          }
          case "resume": {
            if (!args.run_id) {
              return "Error: workflow resume: \`run_id\` is required"
            }
            return JSON.stringify(await runtime.resume({ runID: args.run_id, agentTimeoutMs: args.agent_timeout_ms }))
          }
          default:
            return `Error: unknown operation "${(args as Record<string, unknown>).operation}". Valid: run, status, wait, cancel, resume`
        }
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : String(e)}`
      }
    },
  } as const
}
