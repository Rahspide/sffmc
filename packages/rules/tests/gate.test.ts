// SPDX-License-Identifier: MIT
//
// packages/rules/tests/gate.test.ts — unit tests for the compiled-rule gate.
//
// Covers:
//   - ReDoS regression (bug #5a): unsafe command_match patterns are skipped
//     at compile time, never evaluated against tool-call args.
//   - Happy path: valid regex patterns compile and match as expected.
//   - Invalid syntax: a regex that fails to construct is also skipped.
//   - Default-rule semantics: tool matches, path_outside checks, allow fallback.

import { describe, it, expect } from "bun:test"
import { tmpdir } from "node:os"
import { compileRules, parseRules, type Rules } from "../src/rules.ts"
import { evaluate } from "../src/gate.ts"

// Use the host tmpdir as a portable project root for `path_outside` checks.
// (A previous literal host-specific path failed the public-content audit —
// see bug #5a follow-up.)
const PROJECT_ROOT = tmpdir()

function buildRules(yaml: string): Rules {
  return parseRules(yaml)
}

describe("compileRules — ReDoS guard (bug #5a)", () => {
  it("drops a known-catastrophic command_match pattern and reports the skip", () => {
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "^(a+)+$"
    action: deny
`)
    const { rules, errors } = compileRules(raw)

    // Unsafe rule must not appear in the compiled list.
    expect(rules).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("unsafe command_match")
    expect(errors[0]).toContain("^(a+)+$")
  })

  it("does not evaluate a skipped rule at evaluation time (no ReDoS exposure)", () => {
    // Sanity check: even if the unsafe pattern survived compilation, it
    // would never be reached because it is dropped. We assert that by
    // running evaluate() with the compiled list — it must hit the default
    // "allow" branch instead of the would-be "deny" from the pattern.
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "^(a+)+$"
    action: deny
`)
    const { rules } = compileRules(raw)

    const result = evaluate(
      rules,
      "bash",
      { command: "aaaaaaaaaaaaaaaaaaaaaaaa!" }, // classic ReDoS trigger
      PROJECT_ROOT,
    )

    expect(result.action).toBe("allow")
    expect(result.reason).toBe("no matching rule")
  })

  it("compiles and uses a safe command_match pattern", () => {
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "rm -rf"
    action: deny
`)
    const { rules, errors } = compileRules(raw)

    expect(errors).toHaveLength(0)
    expect(rules).toHaveLength(1)
    expect(rules[0].commandMatch?.source).toBe("rm -rf")

    const result = evaluate(rules, "bash", { command: "rm -rf /tmp" }, PROJECT_ROOT)
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("rm -rf")
  })

  it("drops an invalid-syntax command_match pattern", () => {
    // Unmatched paren — `safe-regex` rejects unparseable patterns with the
    // same "unsafe" return value (it cannot analyze a regex that does not
    // compile). Either way, the rule must be skipped — never evaluated.
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "(unclosed"
    action: deny
`)
    const { rules, errors } = compileRules(raw)

    expect(rules).toHaveLength(0)
    expect(errors).toHaveLength(1)
    // The rule must NOT have a commandMatch attached.
    expect(rules[0]?.commandMatch).toBeUndefined()
  })

  it("keeps non-regex rules (no command_match) untouched", () => {
    const raw = buildRules(`version: 1
rules:
  - match: { tool: read }
    action: allow
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
`)
    const { rules, errors } = compileRules(raw)

    expect(errors).toHaveLength(0)
    expect(rules).toHaveLength(2)
    expect(rules[0].commandMatch).toBeUndefined()
    expect(rules[1].commandMatch).toBeUndefined()
  })

  it("compiles a mixed set — keeps safe rules, drops unsafe ones, surfaces errors", () => {
    const raw = buildRules(`version: 1
rules:
  - match: { tool: read }
    action: allow
  - match:
      tool: bash
      command_match: "^(a+)+$"
    action: deny
  - match:
      tool: bash
      command_match: "sudo "
    action: ask
`)
    const { rules, errors } = compileRules(raw)

    // read (kept), bash+unsafe (dropped), bash+safe (kept).
    expect(rules).toHaveLength(2)
    expect(errors).toHaveLength(1)
    expect(rules[0].match.tool).toBe("read")
    expect(rules[1].commandMatch?.source).toBe("sudo ")
  })
})

describe("evaluate — pre-compiled rules", () => {
  it("returns allow when no rule matches", () => {
    const raw = buildRules(`version: 1
rules:
  - match: { tool: read }
    action: allow
`)
    const { rules } = compileRules(raw)
    const result = evaluate(rules, "bash", { command: "ls" }, PROJECT_ROOT)
    expect(result.action).toBe("allow")
    expect(result.reason).toBe("no matching rule")
  })

  it("returns deny when a tool-only rule matches", () => {
    const raw = buildRules(`version: 1
rules:
  - match: { tool: write }
    action: deny
`)
    const { rules } = compileRules(raw)
    const result = evaluate(
      rules,
      "write",
      { filePath: "/etc/passwd" },
      PROJECT_ROOT,
    )
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("write")
  })

  it("honors path_outside when the target path leaves project root", () => {
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
`)
    const { rules } = compileRules(raw)
    const result = evaluate(
      rules,
      "write",
      { filePath: "/etc/passwd" },
      PROJECT_ROOT,
    )
    expect(result.action).toBe("deny")
    expect(result.reason).toContain("path outside")
  })

  it("allows writes inside project root", () => {
    const raw = buildRules(`version: 1
rules:
  - match: { tool: write }
    action: allow
`)
    const { rules } = compileRules(raw)
    const result = evaluate(
      rules,
      "write",
      { filePath: `${PROJECT_ROOT}/src/index.ts` },
      PROJECT_ROOT,
    )
    expect(result.action).toBe("allow")
  })

  it("does not match a command_match rule when args.command is missing", () => {
    const raw = buildRules(`version: 1
rules:
  - match:
      tool: bash
      command_match: "rm -rf"
    action: deny
`)
    const { rules } = compileRules(raw)
    // No command field — fall through to "no matching rule".
    const result = evaluate(rules, "bash", {}, PROJECT_ROOT)
    expect(result.action).toBe("allow")
  })
})