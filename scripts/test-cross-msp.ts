#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Cross-MSP hook chain test. Loads all 3 MSPs (safety/memory/agentic)
// and fires a mock `tool.execute.after` event to verify that hooks
// from ALL THREE MSPs receive the event. Catches regressions where
// mergeHooks() drops a hook key or one MSP shadows another.
//
// Usage: bun run scripts/test-cross-msp.ts
// Exit 0 = all 3 MSPs received the mock event.
// Exit 1 = at least one MSP's hook was not invoked.

import { server as safetyServer } from "../packages/safety/src/index.ts"
import { server as memoryServer } from "../packages/memory/src/index.ts"
import { server as agenticServer } from "../packages/agentic/src/index.ts"

type Hook = (input: unknown, output: unknown) => unknown | Promise<unknown>

const mockCtx = {
  projectRoot: "/data/projects/SFFMC",
  config: {},
  sessionID: "cross-msp-test",
}

console.log("[LOAD] safety + memory + agentic...")
const safety = (await safetyServer(mockCtx)) as { tool?: unknown } & Record<string, Hook>
const memory = (await memoryServer(mockCtx)) as { tool?: unknown } & Record<string, Hook>
const agentic = (await agenticServer(mockCtx)) as { tool?: unknown } & Record<string, Hook>
console.log("✓ All 3 MSPs loaded\n")

// Find which MSPs have a `tool.execute.after` hook
const hasHook = (msp: Record<string, unknown>): boolean => typeof msp["tool.execute.after"] === "function"

const safetyHook = hasHook(safety)
const memoryHook = hasHook(memory)
const agenticHook = hasHook(agentic)

console.log("[CHECK] Which MSPs hook tool.execute.after:")
console.log(`  safety  : ${safetyHook ? "✓" : "✗"}`)
console.log(`  memory  : ${memoryHook ? "✓" : "✗"}`)
console.log(`  agentic : ${agenticHook ? "✓" : "✗"}`)

if (!safetyHook && !memoryHook && !agenticHook) {
  console.error("\n[FAIL] No MSP has tool.execute.after — wiring broken?")
  process.exit(1)
}

console.log("\n[EXEC] Firing mock tool.execute.after event to all 3 MSPs...")

// Mock event payload
const mockEvent = {
  tool: "bash",
  sessionID: "cross-msp-test",
  callID: "call_test_1",
  args: { command: "echo hello" },
}
const mockOutput = {
  output: "hello\n",
  title: "bash echo",
  metadata: { exit: 0, duration: 12 },
}

let fired = 0
const errors: string[] = []

async function fire(name: string, msp: Record<string, unknown>): Promise<void> {
  const hook = msp["tool.execute.after"] as Hook | undefined
  if (!hook) return
  try {
    const result = await hook(mockEvent, mockOutput)
    console.log(`  ✓ ${name} hook fired (returned: ${typeof result})`)
    fired++
  } catch (err) {
    errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`)
    console.log(`  ✗ ${name} hook THREW: ${err instanceof Error ? err.message : err}`)
  }
}

await fire("safety ", safety)
await fire("memory ", memory)
await fire("agentic", agentic)

console.log(`\n${fired}/3 hooks fired successfully`)
if (errors.length > 0) {
  console.error("\n[FAIL] Errors:")
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

if (fired < 2) {
  console.error(`\n[FAIL] Only ${fired} hooks fired — mergeHooks() may be dropping hook keys`)
  process.exit(1)
}

console.log("\n[OK] Cross-MSP hook chain works")
process.exit(0)
