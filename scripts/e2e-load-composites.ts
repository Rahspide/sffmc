#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// E2E load test for the 5 SFFMC packages (v0.15.0: 2 composites + 3 standalones).
//
// Loads each package's server() in a Bun runtime, calls it with a mock ctx,
// and asserts the mergeHooks output has the expected shape (id match +
// non-zero hook keys for the composites). Catches regressions where a
// package fails to load, mergeHooks returns an empty result, or wiring drifts.
//
// v0.15.0 consolidation: the @sffmc/agentic composite is dissolved into
// @sffmc/runtime (workflow+tool) + @sffmc/cognition (max-mode+compose+health).
// @sffmc/utilities is consumed by other packages as a workspace dep, not
// a plugin entry point — it's intentionally excluded from this load test.
//
// Usage: bun run scripts/e2e-load-composites.ts
// Exit 0 = all packages load with expected shape.
// Exit 1 = at least one package failed.

import { resolve } from "node:path"
import { server as safetyServer, id as safetyId } from "../packages/safety/src/index.ts"
import { server as memoryServer, id as memoryId } from "../packages/memory/src/index.ts"
import { server as runtimeServer, id as runtimeId } from "../packages/runtime/src/index.ts"
import { server as cognitionServer, id as cognitionId } from "../packages/cognition/src/index.ts"

interface PkgSpec {
  readonly id: string
  readonly server: (ctx: unknown) => Promise<Record<string, unknown>>
  readonly expectedHookKeys: number
  readonly expectedTools: number
}

const mockCtx = {
  projectRoot: resolve(import.meta.dir, ".."),
  config: {},
  sessionID: "e2e-test",
}

// v0.15.0: 2 composites (safety=9 hooks, memory=4 hooks/3 tools) + 3 standalones
// (runtime + cognition; utilities is consumed, not a plugin entry).
// Counts are conservative — adjust if mergeHooks shape changes.
const PACKAGES: readonly PkgSpec[] = [
  { id: safetyId,    server: safetyServer,    expectedHookKeys: 9, expectedTools: 0 },
  { id: memoryId,    server: memoryServer,    expectedHookKeys: 4, expectedTools: 3 },
  { id: runtimeId,   server: runtimeServer,   expectedHookKeys: 2, expectedTools: 1 },
  { id: cognitionId, server: cognitionServer, expectedHookKeys: 0, expectedTools: 0 }, // aggregator; sub-packages register
]

let allOk = true

for (const pkg of PACKAGES) {
  try {
    const result = await pkg.server(mockCtx)

    if (result.id !== pkg.id) {
      console.error(`✗ ${pkg.id}: id mismatch — got ${String(result.id)}`)
      allOk = false
      continue
    }

    const hookKeys = Object.keys(result).filter((k) => k !== "id" && k !== "tool")
    const tools = result.tool ? Object.keys(result.tool as Record<string, unknown>) : []

    if (hookKeys.length !== pkg.expectedHookKeys) {
      console.error(
        `✗ ${pkg.id}: expected ${pkg.expectedHookKeys} hook keys, got ${hookKeys.length} (${hookKeys.join(", ")})`,
      )
      allOk = false
      continue
    }

    if (tools.length !== pkg.expectedTools) {
      console.error(
        `✗ ${pkg.id}: expected ${pkg.expectedTools} tools, got ${tools.length} (${tools.join(", ")})`,
      )
      allOk = false
      continue
    }

    console.log(
      `✓ ${pkg.id}: ${hookKeys.length} hook keys [${hookKeys.join(", ")}], ${tools.length} tools [${tools.join(", ")}]`,
    )
  } catch (err) {
    console.error(`✗ ${pkg.id}: server() threw — ${err instanceof Error ? err.message : String(err)}`)
    allOk = false
  }
}

if (!allOk) {
  console.error("\n[FAIL] One or more packages failed load test")
  process.exit(1)
}

console.log("\n[OK] All 4 SFFMC packages loaded with expected shape (utilities is consumed, not a plugin)")

// Some sub-features register setInterval (rules hot-reload) or chokidar
// watchers (memory). They keep the event loop alive, which would prevent
// the script from exiting naturally on success. Force-exit.
process.exit(0)