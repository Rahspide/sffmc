// SPDX-License-Identifier: MIT
//
// scripts/check-redos.ts — ReDoS gate for built-in redaction rules.
//
// Validates every built-in regex pattern in `@sffmc/shared/redact-secrets`
// against the `safe-regex` library (star-height-1 check, default limit 25
// repetitions). A `false` result means the pattern is potentially
// catastrophic — matches would degrade to exponential time on worst-case
// input.
//
// Usage:
//   bun run scripts/check-redos.ts
//
// Exit codes:
//   0 — all built-in rules pass the ReDoS check
//   1 — at least one rule failed (prints the offender's id + source pattern)
//   2 — safe-regex itself raised (missing dep or runtime error)
//
// This gate runs from the precommit chain so a ReDoS regression cannot
// land without review. User-defined rules from `~/.config/sffmc/redact-secrets.yaml`
// are validated separately when `getRules()` compiles them (see
// `shared/src/redact-secrets.ts`); this script only covers the catalogue.

import { resolve } from "node:path"
import { __listBuiltinRedactionRules } from "../shared/src/redact-secrets.ts"

type BuiltinRule = {
  id: string
  pattern: RegExp
  description: string
}

interface SafeRegexModule {
  default: (pattern: RegExp | string, opts?: { limit?: number }) => boolean
}

let safeRegexModule: SafeRegexModule
try {
  // `safe-regex` is a CommonJS module; Bun's interop exposes `default`.
  safeRegexModule = (await import("safe-regex")) as unknown as SafeRegexModule
} catch (err) {
  console.error("[redos] failed to import 'safe-regex' — install it with `bun add -d safe-regex`")
  console.error("[redos] detail:", err instanceof Error ? err.message : String(err))
  process.exit(2)
}

const isSafe = safeRegexModule.default
const REPETITION_LIMIT = 25

const rules: ReadonlyArray<BuiltinRule> = __listBuiltinRedactionRules()

interface Failure {
  id: string
  description: string
  source: string
}

const failures: Failure[] = []
for (const r of rules) {
  // safe-regex's default limit is 25 — we keep it explicit for documentation.
  const ok = isSafe(r.pattern, { limit: REPETITION_LIMIT })
  if (!ok) {
    failures.push({
      id: r.id,
      description: r.description,
      source: r.pattern.source,
    })
  }
}

if (failures.length === 0) {
  console.log(`[redos] ${rules.length}/${rules.length} built-in rules pass ReDoS check (limit=${REPETITION_LIMIT})`)
  process.exit(0)
}

console.error(`[redos] FAIL — ${failures.length}/${rules.length} built-in rules are NOT safe:`)
for (const f of failures) {
  console.error(`  - ${f.id}  (${f.description})`)
  console.error(`      pattern: /${f.source}/`)
}
console.error("")
console.error("[redos] fix: reduce repetition count, anchor the pattern, or replace with a non-regex algorithm.")
console.error("[redos] docs: https://github.com/davisjam/safe-regex")
process.exit(1)
