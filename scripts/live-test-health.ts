#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Live invocation test for sffmc_health tool.
// Actually calls sffmc_health.execute() with a real PluginContext,
// bypassing the SPA UI. Equivalent to typing /sffmc_health in a chat
// session, but without a browser.
//
// Usage: bun run scripts/live-test-health.ts
// Exit 0 = health check returned ok=true.
// Exit 1 = health check failed OR threw.

import { resolve } from "node:path"
import { server as healthServer } from "../packages/health/src/index.ts"
import { server as agenticServer } from "../packages/agentic/src/index.ts"

interface Tool {
  description: string
  parameters: unknown
  execute: (args: unknown, ctx?: unknown) => Promise<unknown>
}

const mockCtx = {
  projectRoot: resolve(import.meta.dir, ".."),
  config: {},
  sessionID: "live-test",
}

console.log("[1/2] Loading @sffmc/cognition standalone...")
const healthResult = await healthServer(mockCtx)
const healthTool = (healthResult.tool as { sffmc_health: Tool }).sffmc_health
if (!healthTool) {
  console.error("✗ sffmc_health tool not registered in health package")
  process.exit(1)
}
console.log("✓ sffmc_health registered in @sffmc/cognition")

console.log("\n[2/2] Loading @sffmc/agentic (composed MSP)...")
const agenticResult = await agenticServer(mockCtx)
const agenticTool = (agenticResult.tool as { sffmc_health?: Tool }).sffmc_health
if (!agenticTool) {
  console.error("✗ sffmc_health tool NOT in agentic MSP (mergeHooks dropped it?)")
  process.exit(1)
}
console.log("✓ sffmc_health registered in @sffmc/agentic (via mergeHooks)")

console.log("\n[EXEC] Calling sffmc_health.execute()...")
const raw = await healthTool.execute({})
const parsed = typeof raw === "string" ? JSON.parse(raw) : (raw as Record<string, unknown>)

console.log(`summary: ${parsed.summary}`)
const checks = parsed.checks as Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }>
console.log("\n[checks]")
for (const c of checks) {
  const icon = c.status === "ok" ? "✓" : c.status === "warn" ? "⚠" : "✗"
  console.log(`  ${icon} ${c.name.padEnd(22)} ${c.status}${c.detail ? "  " + c.detail : ""}`)
}
const failed = checks.filter((c) => c.status !== "ok")
if (failed.length > 0) {
  console.error(`\n✗ ${failed.length} check(s) FAILED:`)
  for (const c of failed) {
    console.error(`  - ${c.name} [${c.status}]: ${c.detail || "(no detail)"}`)
  }
  process.exit(1)
}

console.log(`\n[OK] All ${checks.length} checks pass. sffmc_health works end-to-end.`)
process.exit(0)
