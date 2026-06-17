// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Shared runtime constants used by both `types.ts` and `runtime.ts`.
// Extracted into a dedicated module to break the original
//   types.ts  <->  runtime.ts
// circular import, which caused a TDZ ReferenceError on
// `SCRIPT_DEADLINE_MS` in user environments (5 tests failing in
// `bun test` whenever runtime.ts happened to load first).

import type { SandboxConstraints } from "./types.ts"

/** 12h wall-clock for the sandbox. */
export const SCRIPT_DEADLINE_MS = 12 * 60 * 60 * 1000 // 12h

export const DEFAULT_SANDBOX_CONSTRAINTS: SandboxConstraints = {
  memoryMB: 64,
  maxInstructions: 5_000_000,
  deadlineMs: SCRIPT_DEADLINE_MS,
}
