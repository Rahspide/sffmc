// SPDX-License-Identifier: MIT
// Invocation script for @sffmc/health — runs all checks and prints JSON.
// Usage: bun run scripts/run-health.ts
import { runAllChecks } from "../packages/health/src/index.ts"

const repoRoot = "/data/projects/SFFMC"
const result = await runAllChecks(repoRoot)
console.log(JSON.stringify(result, null, 2))
process.exit(result.ok ? 0 : 1)
