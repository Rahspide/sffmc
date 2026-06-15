#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Random multi-turn test for the 6 SFFMC tools across all 3 MSPs.
// Exercises tools with random valid inputs across 30 turns, with
// cross-turn chaining (e.g., workflow.run → status → wait). Tracks
// every call and categorizes outcomes.
//
// Each turn picks a tool weighted by availability, generates a
// randomized valid input, calls execute(), and logs the result.
// Tracks errors as: OK (tool returned data), ERR_STRING (tool
// returned an error message), THREW (tool raised an exception).
//
// Usage: bun run scripts/random-test-msps.ts [turns]
// Exit 0 = all turns completed without uncaught exception.
// Exit 1 = a tool threw an exception (categorical failure).

import { server as agenticServer } from "../packages/agentic/src/index.ts"
import { server as memoryServer } from "../packages/memory/src/index.ts"

interface Tool {
  description: string
  parameters: unknown
  execute: (args: unknown, ctx?: unknown) => Promise<unknown>
}

interface TurnResult {
  turn: number
  tool: string
  msp: string
  inputKind: string
  status: "OK" | "ERR_STRING" | "THREW" | "MISSING"
  snippet: string
  durationMs: number
}

const TOTAL_TURNS = Number(process.argv[2] ?? "30")
const SANDBOX_TAG = `random-sandbox-${Date.now()}`

const ctx = {
  projectRoot: "/data/projects/SFFMC",
  config: {},
  sessionID: SANDBOX_TAG,
}

// ----- Valid skills list (subset of compose's VALID_SKILLS) -----
const VALID_SKILLS = [
  "ask", "audit-deps", "benchmark", "brainstorm", "code-review",
  "debug", "execute", "feedback", "merge", "new-skill",
  "parallel", "plan", "report", "review", "subagent",
  "tdd", "verify", "worktree",
]

// ----- Random generators per tool -----
const rand = (n: number) => Math.floor(Math.random() * n)
const pick = <T,>(arr: readonly T[]): T => arr[rand(arr.length)]!
const randStr = (len = 8) =>
  Math.random().toString(36).slice(2, 2 + len)
function genWorkflowInput() {
  const r = Math.random()
  if (r < 0.7) {
    const name = `rand-${randStr(4)}`
    const script =
      `export const meta = { name: "${name}", description: "Random test workflow" };\n` +
      `export default async function(args, ctx) { return { ok: true, turn: ${rand(9999)} }; }`
    return { operation: "run", script, args: { seed: randStr() } }
  }
  return { operation: "list" }  // operation: list works
}

function genComposeInput() {
  return { name: pick(VALID_SKILLS) }
}

function genHealthInput() {
  return {}
}

function genCheckpointInput() {
  const r = Math.random()
  if (r < 0.5) return { action: "list" }
  if (r < 0.85) return { action: "restore", sessionID: `ses_fake_${randStr(8)}` }
  return { action: "list" } // safe default — skip delete (destructive)
}

function genJudgeInput() {
  const n = 3 + rand(3) // 3-5 candidates
  return {
    candidates: Array.from({ length: n }, (_, i) => `candidate-${i}-${randStr(4)}`),
    rubric: Math.random() < 0.3 ? `Rubric ${randStr(6)}` : undefined,
  }
}

function genDreamInput() {
  return { dry_run: true } // always safe
}

interface ToolEntry {
  msp: string
  tool: string
  generator: () => unknown
}

const TOOLS: readonly ToolEntry[] = [
  { msp: "@sffmc/agentic", tool: "workflow", generator: () => genWorkflowInput() },
  { msp: "@sffmc/agentic", tool: "compose_skill", generator: genComposeInput },
  { msp: "@sffmc/agentic", tool: "sffmc_health", generator: genHealthInput },
  { msp: "@sffmc/memory", tool: "extra_checkpoint", generator: genCheckpointInput },
  { msp: "@sffmc/memory", tool: "extra_judge", generator: genJudgeInput },
  { msp: "@sffmc/memory", tool: "extra_dream", generator: genDreamInput },
]

// ----- Main loop -----
console.log(`[random-test] ${TOTAL_TURNS} turns across 6 tools, sessionID=${SANDBOX_TAG}\n`)

console.log("[load] loading agentic + memory MSPs...")
const agenticResult = await agenticServer(ctx)
const memoryResult = await memoryServer(ctx)
console.log("✓ both MSPs loaded\n")

const results: TurnResult[] = []
let lastRunID: string | undefined

const t0 = Date.now()

for (let turn = 1; turn <= TOTAL_TURNS; turn++) {
  const entry = pick(TOOLS)
  // For workflow, inject lastRunID if available
  let args: unknown
  if (entry.tool === "workflow" && lastRunID && Math.random() < 0.5) {
    args = { operation: "status", run_id: lastRunID }
  } else {
    args = entry.generator()
  }

  const tStart = Date.now()
  let status: TurnResult["status"] = "OK"
  let snippet = ""

  try {
    const msps = entry.msp === "@sffmc/agentic" ? agenticResult : memoryResult
    const t = (msps.tool as Record<string, Tool>)[entry.tool]
    if (!t) {
      status = "MISSING"
      snippet = `tool not in ${entry.msp}`
    } else {
      const raw = await t.execute(args, ctx)
      const str = typeof raw === "string" ? raw : JSON.stringify(raw)
      // Detect error string vs success
      if (str.startsWith("Error:") || /^\{"ok":false/.test(str)) {
        status = "ERR_STRING"
      }
      // Capture runID for chaining
      try {
        const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
        if (parsed && typeof parsed === "object" && "runID" in parsed && typeof parsed.runID === "string") {
          lastRunID = parsed.runID
        }
      } catch { /* not JSON or no runID */ }
      snippet = str.slice(0, 100).replace(/\n/g, " ")
    }
  } catch (err) {
    status = "THREW"
    snippet = err instanceof Error ? err.message.slice(0, 100) : String(err).slice(0, 100)
  }

  const durationMs = Date.now() - tStart
  results.push({
    turn,
    tool: entry.tool,
    msp: entry.msp,
    inputKind: typeof args === "object" && args !== null && "operation" in args
      ? String((args as { operation?: string }).operation)
      : typeof args === "object" && args !== null && "action" in args
        ? String((args as { action?: string }).action)
        : typeof args === "object" && args !== null && "name" in args && typeof (args as { name: unknown }).name === "string"
          ? `name=${(args as { name: string }).name}`
          : "—",
    status,
    snippet,
    durationMs,
  })
}

const totalMs = Date.now() - t0

// ----- Report -----
console.log("[turns]")
for (const r of results) {
  const icon = r.status === "OK" ? "✓" : r.status === "ERR_STRING" ? "⚠" : r.status === "THREW" ? "✗" : "?"
  console.log(
    `  ${icon} T${String(r.turn).padStart(2)} ${r.tool.padEnd(18)} ${r.inputKind.padEnd(20)} ${r.status.padEnd(10)} ${r.durationMs}ms  ${r.snippet.slice(0, 60)}`,
  )
}

console.log("\n[stats]")
const byStatus: Record<string, number> = {}
const byTool: Record<string, { ok: number; err: number; threw: number; missing: number }> = {}
for (const r of results) {
  byStatus[r.status] = (byStatus[r.status] ?? 0) + 1
  if (!byTool[r.tool]) byTool[r.tool] = { ok: 0, err: 0, threw: 0, missing: 0 }
  if (r.status === "OK") byTool[r.tool].ok++
  else if (r.status === "ERR_STRING") byTool[r.tool].err++
  else if (r.status === "THREW") byTool[r.tool].threw++
  else byTool[r.tool].missing++
}

console.log("  Total: ", results.length, "turns in", totalMs, "ms")
console.log("  By status:", JSON.stringify(byStatus))
console.log("  By tool:")
for (const [t, s] of Object.entries(byTool).sort()) {
  console.log(`    ${t.padEnd(20)} ok=${s.ok} err=${s.err} threw=${s.threw}${s.missing ? ` missing=${s.missing}` : ""}`)
}

const threw = byStatus["THREW"] ?? 0
if (threw > 0) {
  console.error(`\n[FAIL] ${threw} tool call(s) threw uncaught exceptions`)
  process.exit(1)
}

console.log("\n[OK] All turns completed without uncaught exceptions")
process.exit(0)
