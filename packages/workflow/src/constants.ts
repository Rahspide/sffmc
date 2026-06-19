// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Shared runtime constants used by both `types.ts` and `runtime.ts`.
// Extracted into a dedicated module to break the original
//   types.ts  <->  runtime.ts
// circular import, which caused a TDZ ReferenceError on
// `SCRIPT_DEADLINE_MS` in user environments (5 tests failing in
// `bun test` whenever runtime.ts happened to load first).

import type { SandboxConstraints } from "./types.ts"

/** 1h wall-clock for the sandbox. Matches maxWallClockMs to prevent
 *  mismatches where the sandbox runs 12x longer than the workflow. */
export const SCRIPT_DEADLINE_MS = 60 * 60 * 1000 // 1h

export const DEFAULT_SANDBOX_CONSTRAINTS: SandboxConstraints = {
  memoryMB: 64,
  maxInstructions: 5_000_000,
  deadlineMs: SCRIPT_DEADLINE_MS,
}

/** Single source of truth for workflow budget defaults.
 *  Used by BOTH `types.ts` (DEFAULT_WORKFLOW_CONFIG) and `schema.ts`
 *  (SCHEMA_SQL column defaults). Drift between TS and SQL is a hardcode
 *  hazard — changing one without the other silently changes effective
 *  caps based on whether rows pre-existed. */
export const WORKFLOW_LIMITS = {
  maxSteps: 200,
  maxTokens: 2_000_000,
  maxWallClockMs: 3_600_000, // 1 hour
  perStepTimeoutMs: 120_000, // 2 minutes
} as const

/** Directories (under the workspace, walked upward) where saved workflows
 *  may be looked up by name. Order matters — first match wins. The
 *  `.sffmc/workflows` namespace is SFFMC's own; `.claude/workflows`
 *  is the legacy Claude convention for backward compatibility. */
export const WORKFLOW_SEARCH_DIRS = [".sffmc/workflows", ".claude/workflows"] as const

/** Hard cap on the total number of agents a workflow can spawn across
 *  its entire lifetime. Bounded so a buggy recursive workflow can't
 *  exhaust host resources. */
export const MAX_LIFECYCLE_AGENTS = 1000

/** Default max nesting depth for nested workflow invocations. Beyond 8
 *  the call graph becomes too deep to reason about; users can override
 *  via the per-run config. */
export const MAX_DEPTH_DEFAULT = 8
