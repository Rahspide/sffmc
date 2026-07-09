// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Script SHA computation, extracted from persistence.ts per the v0.16.0
// refactor plan (ora-9, Phase 2). WorkflowPersistence stores the script
// SHA in the runs table for fast equality checks (two runs of the same
// script share a SHA, so resume can skip the re-parse path).

import { createHash } from "node:crypto"

export function computeScriptSha(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}
