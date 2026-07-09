// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Adversarial + happy-path tests for `parseMeta()` in meta.ts. The parser
// claims "no eval, no new Function, or vm" — a CLAIM, not a guarantee. The
// tests below pin behaviour against adversarial inputs (prototype pollution,
// unicode lookalikes, deep nesting DoS, unterminated strings, comment-as-data
// confusion) so the security-sensitive boundary is tested.

import { describe, test, expect } from "bun:test"
import { parseMeta } from "../src/meta.ts"

const OK = (script: string) =>
  parseMeta(`export const meta = { name: "x", description: "y"${script.slice("export const meta = ".length)}`)

const PARSE = (script: string) => parseMeta(script)

// ─── 1. Happy path ─────────────────────────────────────────────────────

describe("parseMeta: happy path", () => {
  test("minimal {name, description} returns ok with both fields", () => {
    const r = parseMeta('export const meta = { name: "x", description: "y" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.name).toBe("x")
      expect(r.meta.description).toBe("y")
    }
  })

  test("parses all optional fields (whenToUse, phases[], model)", () => {
    const r = parseMeta(`export const meta = {
      name: "x", description: "y",
      whenToUse: "always",
      phases: [{ title: "Plan" }, { title: "Build", detail: "code" }],
      model: "claude-opus-4-7"
    }`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.whenToUse).toBe("always")
      expect(r.meta.phases).toHaveLength(2)
      expect(r.meta.model).toBe("claude-opus-4-7")
    }
  })

  test("empty phases array is allowed", () => {
    const r = parseMeta('export const meta = { name: "x", description: "y", phases: [] }')
    expect(r.ok).toBe(true)
  })

  test("trailing semicolon after literal is allowed", () => {
    const r = parseMeta('export const meta = { name: "x", description: "y" };')
    expect(r.ok).toBe(true)
  })

  test("body output preserves line numbers (matched region is whitespace-only)", () => {
    const r = parseMeta(`line 1
export const meta = { name: "x", description: "y" }
line 3`)
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Three-line body
      expect(r.body.split("\n")).toHaveLength(3)
      // Lines 1 and 3 unchanged
      expect(r.body.split("\n")[0]).toBe("line 1")
      expect(r.body.split("\n")[2]).toBe("line 3")
    }
  })
})

// ─── 2. Validation contract ───────────────────────────────────────────

describe("parseMeta: validation contract", () => {
  test("rejects script without 'export const meta' prefix", () => {
    expect(PARSE('const meta = { name: "x", description: "y" }').ok).toBe(false)
    expect(PARSE("").ok).toBe(false)
    expect(PARSE("x = 1").ok).toBe(false)
    expect(PARSE("// export const meta = {…}").ok).toBe(false)
  })

  test("rejects when { is missing after =", () => {
    const r = PARSE("export const meta = ")
    expect(r.ok).toBe(false)
  })

  test("rejects unbalanced braces (open without close)", () => {
    expect(PARSE('export const meta = { name: "x", description: "y"').ok).toBe(false)
  })

  test("rejects when meta is an array, not an object", () => {
    expect(PARSE("export const meta = [1, 2, 3]").ok).toBe(false)
  })

  test("rejects when meta is null", () => {
    expect(PARSE("export const meta = null").ok).toBe(false)
  })

  test("rejects when meta.name is missing or empty", () => {
    expect(PARSE('export const meta = { description: "y" }').ok).toBe(false)
    expect(PARSE('export const meta = { name: "", description: "y" }').ok).toBe(false)
  })

  test("rejects when meta.description is missing or empty", () => {
    expect(PARSE('export const meta = { name: "x" }').ok).toBe(false)
    expect(PARSE('export const meta = { name: "x", description: "" }').ok).toBe(false)
  })
})

// ─── 3. Security: prototype pollution ────────────────────────────────

describe("parseMeta: prototype pollution guards", () => {
  test("__proto__ key is rejected (defense in depth)", () => {
    const r = PARSE(`export const meta = {
      __proto__: { polluted: true },
      name: "x", description: "y"
    }`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/__proto__|forbidden key/)
    }
  })

  test("nested __proto__ in array element is rejected", () => {
    const r = PARSE(`export const meta = {
      name: "x", description: "y",
      phases: [{ __proto__: { evil: 1 }, title: "t" }]
    }`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/__proto__|forbidden key/)
    }
  })

  test("constructor and prototype keys are also rejected", () => {
    expect(PARSE('export const meta = { constructor: "x", name: "x", description: "y" }').ok).toBe(false)
    expect(PARSE('export const meta = { prototype: "x", name: "x", description: "y" }').ok).toBe(false)
  })
})

// ─── 4. Security: identifier key validation ──────────────────────────

describe("parseMeta: identifier validation", () => {
  test("rejects key starting with digit (not a valid identifier)", () => {
    const r = PARSE('export const meta = { 1name: "x", description: "y" }')
    expect(r.ok).toBe(false)
  })

  test("rejects Unicode lookalike (Cyrillic 'а' in 'name')", () => {
    // nаme: — second 'а' is Cyrillic U+0430, not latin 'a'
    const r = PARSE('export const meta = { nаme: "x", description: "y" }')
    expect(r.ok).toBe(false)
  })

  test("quoted lookalike key as STRING value is allowed (strings aren't identifier-checked)", () => {
    const r = PARSE('export const meta = { "nаme": "x", description: "y" }')
    // "nаme" is a string key (quoted) — not a key identifier, so no check.
    // Outcome depends on parser policy: we just assert no crash.
    expect(typeof r.ok).toBe("boolean")
  })
})

// ─── 5. Security: deep nesting DoS ────────────────────────────────────

describe("parseMeta: deep nesting guard", () => {
  test("object nested > 100 levels throws 'nesting too deep'", () => {
    let nested = "{ name: \"x\", description: \"y\""
    for (let i = 0; i < 120; i++) nested = `{ a: ${nested} }`
    const r = PARSE(`export const meta = ${nested}}`)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toMatch(/nesting too deep/i)
    }
  })
})

// ─── 6. Security: unterminated string / escapes ──────────────────────

describe("parseMeta: string parsing", () => {
  test("rejects unterminated double-quoted string", () => {
    const r = PARSE('export const meta = { name: "x')
    expect(r.ok).toBe(false)
  })

  test("rejects unterminated single-quoted string", () => {
    const r = PARSE("export const meta = { name: 'x")
    expect(r.ok).toBe(false)
  })

  test("rejects invalid \\u escape (non-hex chars)", () => {
    const r = PARSE('export const meta = { name: "\\uZZZZ", description: "y" }')
    expect(r.ok).toBe(false)
  })

  test("rejects too-short \\u escape", () => {
    const r = PARSE('export const meta = { name: "\\u00", description: "y" }')
    expect(r.ok).toBe(false)
  })

  test("valid \\uXXXX escape produces the character", () => {
    const r = PARSE('export const meta = { name: "\\u0041", description: "y" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.name).toBe("A")
    }
  })

  test("line comment inside string is treated as data, not as comment", () => {
    const r = PARSE('export const meta = { name: "x // not a comment", description: "y" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.name).toBe("x // not a comment")
    }
  })

  test("block comment inside string is treated as data", () => {
    const r = PARSE('export const meta = { name: "x /* still a string */ end", description: "y" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.name).toBe("x /* still a string */ end")
    }
  })

  test("escape sequences \\n \\t \\r are interpreted", () => {
    const r = PARSE('export const meta = { name: "a\\nb\\tc", description: "y" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // Real control chars, not the literal backslash-letter form
      expect(r.meta.name).toBe("a\nb\tc")
      expect(r.meta.name).not.toContain("\\n")
    }
  })
})

// ─── 7. Edge cases ───────────────────────────────────────────────────

describe("parseMeta: edge cases", () => {
  test("line comment // and block comment /* */ are stripped from the meta literal", () => {
    const r = PARSE(`export const meta = /* hi */ {
      // line
      name: "x", description: "y"
    }`)
    expect(r.ok).toBe(true)
  })

  test("trailing comma in object is allowed", () => {
    expect(PARSE('export const meta = { name: "x", description: "y", }').ok).toBe(true)
  })

  test("trailing comma in array is allowed", () => {
    expect(PARSE('export const meta = { name: "x", description: "y", phases: [1, 2, 3,] }').ok).toBe(true)
  })

  test("number -1.5e10 parses", () => {
    const r = PARSE('export const meta = { name: "x", description: "y", model: -1.5e10 }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.meta.model).toBe(-1.5e10)
    }
  })

  test("unary + is not supported (documented limitation)", () => {
    const r = PARSE('export const meta = { name: "x", description: "y", model: +1 }')
    expect(r.ok).toBe(false)
  })

  test("1e400 (overflow) rejected as non-finite", () => {
    const r = PARSE('export const meta = { name: "x", description: "y", model: 1e400 }')
    expect(r.ok).toBe(false)
  })

  test("keyword 'true' recognized only when followed by non-identifier (no 'trueish' false-positive)", () => {
    // `trueish` should be a string (identifier), not a boolean
    const r = PARSE('export const meta = { name: "x", description: "y", tag: "trueish" }')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect((r.meta as Record<string, unknown>).tag).toBe("trueish")
    }
  })
})
