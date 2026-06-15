#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// E2E load test for the 3 SFFMC MSPs.
//
// Loads each MSP's server() in a Bun runtime, calls it with a mock ctx,
// and asserts the mergeHooks output has the expected hook count and
// tool count for that MSP. Catches regressions where a sub-feature
// fails to load, mergeHooks returns an empty result, or wiring drifts.
//
// Usage: bun run scripts/e2e-load-msps.ts
// Exit 0 = all 3 MSPs load with expected shape.
// Exit 1 = at least one MSP failed.

import { server as safetyServer, id as safetyId } from "../packages/safety/src/index.ts"
import { server as memoryServer, id as memoryId } from "../packages/memory/src/index.ts"
import { server as agenticServer, id as agenticId } from "../packages/agentic/src/index.ts"

interface MspSpec {
  readonly id: string
  readonly server: (ctx: unknown) => Promise<Record<string, unknown>>
  readonly expectedHookKeys: number
  readonly expectedTools: number
}

const mockCtx = {
  projectRoot: "/data/projects/SFFMC",
  config: {},
  sessionID: "e2e-test",
}

const MSPS: readonly MspSpec[] = [
  { id: safetyId, server: safetyServer, expectedHookKeys: 9, expectedTools: 0 },
  { id: memoryId, server: memoryServer, expectedHookKeys: 4, expectedTools: 3 },
  { id: agenticId, server: agenticServer, expectedHookKeys: 5, expectedTools: 3 },
]

let allOk = true

for (const msp of MSPS) {
  try {
    const result = await msp.server(mockCtx)

    if (result.id !== msp.id) {
      console.error(`✗ ${msp.id}: id mismatch — got ${String(result.id)}`)
      allOk = false
      continue
    }

    const hookKeys = Object.keys(result).filter((k) => k !== "id" && k !== "tool")
    const tools = result.tool ? Object.keys(result.tool as Record<string, unknown>) : []

    if (hookKeys.length !== msp.expectedHookKeys) {
      console.error(
        `✗ ${msp.id}: expected ${msp.expectedHookKeys} hook keys, got ${hookKeys.length} (${hookKeys.join(", ")})`,
      )
      allOk = false
      continue
    }

    if (tools.length !== msp.expectedTools) {
      console.error(
        `✗ ${msp.id}: expected ${msp.expectedTools} tools, got ${tools.length} (${tools.join(", ")})`,
      )
      allOk = false
      continue
    }

    console.log(
      `✓ ${msp.id}: ${hookKeys.length} hook keys [${hookKeys.join(", ")}], ${tools.length} tools [${tools.join(", ")}]`,
    )
  } catch (err) {
    console.error(`✗ ${msp.id}: server() threw — ${err instanceof Error ? err.message : String(err)}`)
    allOk = false
  }
}

if (!allOk) {
  console.error("\n[FAIL] One or more MSPs failed load test")
  process.exit(1)
}

console.log("\n[OK] All 3 MSPs loaded with expected shape")

// Some sub-features register setInterval (rules hot-reload) or chokidar
// watchers (memory). They keep the event loop alive, which would prevent
// the script from exiting naturally on success. Force-exit.
process.exit(0)
