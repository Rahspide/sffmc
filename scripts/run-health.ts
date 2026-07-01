// SPDX-License-Identifier: MIT
// Invocation script for @sffmc/cognition — runs all checks and prints JSON.
// Usage: bun run scripts/run-health.ts
import { resolve } from "node:path"
import { runAllChecks } from "../packages/cognition/src/health/src/index.ts"

const repoRoot = resolve(import.meta.dir, "..")
const result = await runAllChecks(repoRoot)
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
