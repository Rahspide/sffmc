#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Live invocation test for the 5 non-health SFFMC tools.
// Calls execute() on each: workflow, compose_skill, extra_checkpoint,
// extra_judge, extra_dream. Catches regressions where a tool fails to
// load in the composed MSP, or its execute() throws on a valid call.
//
// Usage: bun run scripts/live-test-tools.ts
// Exit 0 = all 5 tools executed without throwing.
// Exit 1 = at least one tool failed.

import { server as agenticServer } from "../packages/agentic/src/index.ts"
import { server as memoryServer } from "../packages/memory/src/index.ts"

interface Tool {
  description: string
  parameters: unknown
  execute: (args: unknown, ctx?: unknown) => Promise<unknown>
}

const mockCtx = {
  projectRoot: "/data/projects/SFFMC",
  config: {},
  sessionID: "live-test-tools",
}

let pass = 0
let fail = 0
const results: Array<{ name: string; status: string; summary: string }> = []

async function callTool(
  msps: Record<string, { tool?: Record<string, Tool> }>,
  mspId: string,
  toolName: string,
  args: unknown,
  label: string,
): Promise<void> {
  const tools = msps[mspId]?.tool
  if (!tools || !tools[toolName]) {
    results.push({ name: label, status: "MISSING", summary: `tool not in ${mspId}` })
    fail++
    return
  }
  try {
    const raw = await tools[toolName].execute(args, mockCtx)
    const summary = typeof raw === "string" ? raw.slice(0, 120) : JSON.stringify(raw).slice(0, 120)
    results.push({ name: label, status: "OK", summary })
    pass++
  } catch (err) {
    results.push({
      name: label,
      status: "THREW",
      summary: err instanceof Error ? err.message : String(err),
    })
    fail++
  }
}

console.log("[LOAD] Loading agentic + memory MSPs...")
const agentic = await agenticServer(mockCtx)
const memory = await memoryServer(mockCtx)
const msps: Record<string, { tool?: Record<string, Tool> }> = {
  "@sffmc/agentic": agentic as { tool?: Record<string, Tool> },
  "@sffmc/memory": memory as { tool?: Record<string, Tool> },
}
console.log("✓ Both MSPs loaded\n")

console.log("[EXEC] Calling 5 tools in parallel...\n")

// 1. workflow — proper inline script (must have `export const meta = {...}`)
await callTool(
  msps,
  "@sffmc/agentic",
  "workflow",
  {
    operation: "run",
    script:
      'export const meta = { name: "live-test-echo", description: "Test workflow for live-test script" };\n' +
      '\nexport default async function(args, ctx) { return { ok: true, echo: args?.test ?? "no-args" } }',
    args: { test: "live-test" },
  },
  "workflow (inline script)",
)

// 2. compose_skill — ask skill
await callTool(
  msps,
  "@sffmc/agentic",
  "compose_skill",
  { name: "ask" },
  "compose_skill (ask)",
)

// 3. extra_checkpoint — list action
await callTool(msps, "@sffmc/memory", "extra_checkpoint", { action: "list" }, "extra_checkpoint (list)")

// 4. extra_judge — minimal candidates
await callTool(
  msps,
  "@sffmc/memory",
  "extra_judge",
  { candidates: ["foo", "bar", "baz"] },
  "extra_judge (3 cands)",
)

// 5. extra_dream — dry run
await callTool(msps, "@sffmc/memory", "extra_dream", { dry_run: true }, "extra_dream (dry_run)")

console.log("\n[results]")
for (const r of results) {
  const icon = r.status === "OK" ? "✓" : "✗"
  console.log(`  ${icon} ${r.name.padEnd(28)} ${r.status.padEnd(8)} ${r.summary}`)
}
console.log(`\n${pass} pass, ${fail} fail`)

process.exit(fail > 0 ? 1 : 0)
