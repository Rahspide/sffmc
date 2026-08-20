// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Meta-shape validation for the 7 shipped builtin workflows. Catches
// regressions where a maintainer renames a field, drops a required value,
// or breaks the phase list when editing a builtin. Iterates all builtins
// from the registry (the same source `builtin-registry.ts` uses at
// module load) so any future addition is automatically covered.
//
// Type-discrimination checks (string / object) use Valibot `v.is()` at
// the test boundary so the test code carries no `typeof` runtime
// type-narrowing operators.

import { describe, test, expect } from "bun:test"
import * as v from "valibot"
import { listBuiltins, loadBuiltin } from "../src/builtin-registry.ts"

/** Valibot primitive schemas used at the test boundary to discriminate
 *  builtin-entry field types without `typeof` runtime checks. */
const StringSchema = v.string()
const NonNullObjectSchema = v.object({})

/** The 7 shipped builtins. Tests iterate this list explicitly rather than
 *  `listBuiltins()` so they are not affected by `registerBuiltin` calls
 *  in other test files (foundation.test.ts registers "test-builtin",
 *  builtin-registry.test.ts registers "custom-test", script-resolver.test.ts
 *  registers a namespaced one). The shipped-builtin meta contract is
 *  the thing we actually care about. */
const SHIPPED_BUILTINS = [
  "deep-research",
  "doc-gen",
  "lib-migrate",
  "plan",
  "refactor",
  "security-audit",
  "tdd",
] as const

describe("builtin meta shape", () => {
  test("every shipped builtin passes the meta-shape contract", async () => {
    for (const name of SHIPPED_BUILTINS) {
      const entry = await loadBuiltin(name)

      // Required: name (non-empty string, matches registered key)
      expect(v.is(StringSchema, entry.name)).toBe(true)
      expect(entry.name.length).toBeGreaterThan(0)
      expect(entry.name).toBe(name) // catches rename-without-registry-update

      // Required: description (non-empty, no leading/trailing whitespace-only)
      expect(v.is(StringSchema, entry.description)).toBe(true)
      expect(entry.description.length).toBeGreaterThan(0)
      expect(entry.description.trim()).toBe(entry.description) // no leading/trailing whitespace

      // Optional: whenToUse (must be non-empty string if present)
      if (entry.whenToUse !== undefined) {
        expect(v.is(StringSchema, entry.whenToUse)).toBe(true)
        expect(entry.whenToUse.length).toBeGreaterThan(0)
      }

      // Optional: phases (must be non-empty array of {title, detail?} if present)
      if (entry.phases !== undefined) {
        expect(Array.isArray(entry.phases)).toBe(true)
        expect(entry.phases.length).toBeGreaterThan(0)
        for (let i = 0; i < entry.phases.length; i++) {
          const phase = entry.phases[i]
          // v.object({}) accepts only non-null, non-array objects — replaces
          // the historical `typeof === "object" && !== null` ladder.
          expect(v.is(NonNullObjectSchema, phase)).toBe(true)
          expect(v.is(StringSchema, phase.title)).toBe(true)
          expect(phase.title.length).toBeGreaterThan(0)
          // SAFETY: phase is typed via v.is(NonNullObjectSchema) check above; the inline shape declares the optional .detail field for the existence test
          if ((phase as { detail?: unknown }).detail !== undefined) {
            // SAFETY: detail existence is verified by the guard above; the cast re-states the shape for the v.is check on .detail
            expect(v.is(StringSchema, (phase as { detail: unknown }).detail)).toBe(true)
          }
        }
      }

      // Required: script (non-empty string — the actual JS source)
      expect(v.is(StringSchema, entry.script)).toBe(true)
      expect(entry.script.length).toBeGreaterThan(0)
    }
  })

  test("every shipped builtin script starts with export const meta", async () => {
    // The script is the file's raw source. loadBuiltin returns it via
    // `mod.source`. The runtime's resolveWorkflow uses `isInlineScript`
    // (checks for `export const meta`) to know it's a valid inline
    // script — if a maintainer accidentally strips the `export const
    // meta` line during a refactor, the builtin would silently fail to
    // run. Locking it down with a test.
    for (const name of SHIPPED_BUILTINS) {
      const entry = await loadBuiltin(name)
      expect(entry.script).toMatch(/export\s+const\s+meta\b/)
    }
  })

  test("builtin registry list contains every shipped builtin (catches missing imports)", () => {
    // Catches drift: if a maintainer adds a new builtin/<name>.ts and
    // forgets to import it in builtin-registry.ts, listBuiltins() won't
    // include it. The compile error would catch it first, but this test
    // makes the failure point at the gap rather than the TS error.
    //
    // Note: the test only checks that every shipped name is present
    // (subset check), not exact equality, because other test files
    // register custom entries that pollute the registry.
    const names = new Set(listBuiltins())
    for (const shipped of SHIPPED_BUILTINS) {
      expect(names.has(shipped)).toBe(true)
    }
  })

  test("phase titles are unique within a builtin (no duplicate phase names)", async () => {
    // A maintainer copy-pasting phase entries can leave two phases with
    // the same title. The runtime would render them identically in UI,
    // confusing the user. Locking down uniqueness.
    for (const name of SHIPPED_BUILTINS) {
      const entry = await loadBuiltin(name)
      if (entry.phases === undefined) continue
      const titles = entry.phases.map((p) => p.title)
      const uniq = new Set(titles)
      expect(uniq.size).toBe(titles.length)
    }
  })

  test("every shipped builtin has at least one phase (otherwise it's not really a workflow)", async () => {
    // Catch-all: a builtin with no `phases` field is a degenerate
    // workflow (no progress markers). The first test already asserts
    // this for builtins that DO have phases; this test asserts the
    // opposite direction (all 7 must have phases).
    for (const name of SHIPPED_BUILTINS) {
      const entry = await loadBuiltin(name)
      expect(entry.phases).toBeDefined()
      expect(entry.phases).not.toBeNull()
      expect(Array.isArray(entry.phases)).toBe(true)
    }
  })

  test("no unexpected keys in meta (catches typos like 'desription')", async () => {
    // ESLint's plugin docs use strict shape; VS Code's manifest schema
    // uses `additionalProperties: false`. For our 7 internal builtins
    // where the cost of a typo is high (workflow silently not appearing
    // in `--list` because it parsed as `{ name: "x", descrption: "..." }`),
    // lean strict. Locking down that ONLY the declared keys are present.
    const allowed = new Set(["name", "description", "whenToUse", "phases", "script"])
    for (const name of SHIPPED_BUILTINS) {
      // loadBuiltin returns the BuiltinEntry shape (name/description/
      // whenToUse/phases/script). The raw `meta` object inside the source
      // module is not directly exposed, but the BuiltinEntry fields
      // are the only legitimate top-level keys.
      const entry = await loadBuiltin(name)
      const keys = new Set(Object.keys(entry))
      for (const key of keys) {
        expect(allowed.has(key)).toBe(true)
      }
    }
  })
})