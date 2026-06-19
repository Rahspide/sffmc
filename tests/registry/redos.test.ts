// SPDX-License-Identifier: MIT
//
// tests/registry/redos.test.ts — ReDoS regression guard for the redact-secrets
// rule catalogue. Runs `safe-regex` against every built-in pattern; if any
// fails, the test reports the offender and fails the suite.
//
// Mirrors `scripts/check-redos.ts` so the same coverage runs both as a
// precommit gate (fast, scripted) and as part of `bun test` (full test run).
//
// Threshold: star-height ≤ 1 (no nested quantifiers) AND total repetition
// count ≤ 25 (the `safe-regex` default). Both are the upstream defaults —
// do NOT loosen without a documented exception.

import { describe, it, expect } from "bun:test"
import safeRegex from "safe-regex"
import { __listBuiltinRedactionRules } from "../../shared/src/redact-secrets.ts"

const REPETITION_LIMIT = 25

describe("registry/redos — built-in redact rules", () => {
  const rules = __listBuiltinRedactionRules()

  it("catalogue is non-empty", () => {
    expect(rules.length).toBeGreaterThan(0)
  })

  it("every built-in pattern has a stable id", () => {
    const ids = new Set<string>()
    for (const r of rules) {
      expect(typeof r.id).toBe("string")
      expect(r.id.length).toBeGreaterThan(0)
      expect(ids.has(r.id)).toBe(false) // no duplicates
      ids.add(r.id)
    }
  })

  it("every built-in pattern has a description", () => {
    for (const r of rules) {
      expect(typeof r.description).toBe("string")
      expect(r.description.length).toBeGreaterThan(0)
    }
  })

  it("every built-in pattern passes the ReDoS check (star-height ≤ 1, rep count ≤ 25)", () => {
    const failures: Array<{ id: string; pattern: string }> = []
    for (const r of rules) {
      const ok = safeRegex(r.pattern, { limit: REPETITION_LIMIT })
      if (!ok) {
        failures.push({ id: r.id, pattern: r.pattern.source })
      }
    }
    if (failures.length > 0) {
      const lines = failures.map((f) => `  - ${f.id}: /${f.pattern}/`).join("\n")
      throw new Error(
        `${failures.length}/${rules.length} built-in patterns are NOT safe-regex clean:\n${lines}\n\n` +
          `Fix: rewrite the pattern to avoid nested quantifiers (e.g. ` +
          `'^name(\\.\\w+)?$' → '^(?:name|name\\.\\w+)$'), ` +
          `or document an exception in scripts/check-redos.ts.`,
      )
    }
  })

  it("known-fixed filename patterns are equivalent to the legacy form", () => {
    // Regression guard: the rewrite that satisfies safe-regex must preserve
    // the same match set as the legacy `^name(\.[\w-]+)?$` shape. If anyone
    // tightens the pattern further, this test catches unintended matches.
    const equivCases: Array<[string, boolean]> = [
      [".env", true],
      [".env.production", true],
      [".env.local.bak.test", false], // multi-dot (both legacy and new reject)
      ["credentials", true],
      ["credentials.json", true],
      ["credentials-checklist.md", false],
      ["secret", true],
      ["secrets", true],
      ["secret.md", true],
      ["tokens.json", true],
      ["apikey.json", true],
      ["api-key.json", true],
      ["api-keys-rotation.md", false],
      ["private_key.pem", true],
      ["private-key.pem", true],
    ]
    const filenameIds = new Set([
      "env-file",
      "filename-credentials",
      "filename-secrets",
      "filename-password",
      "filename-token",
      "filename-api-key",
      "filename-private-key",
    ])
    const filenameRules = rules.filter((r) => filenameIds.has(r.id))
    expect(filenameRules.length).toBe(7)
    for (const [name, shouldMatch] of equivCases) {
      const matched = filenameRules.some((r) => r.pattern.test(name))
      expect(matched).toBe(shouldMatch)
    }
  })
})
