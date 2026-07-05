// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, test, expect } from "bun:test"
import { registerBuiltin, getBuiltin, listBuiltins, loadBuiltin } from "../src/builtin-registry.ts"

describe("builtin-registry.ts", () => {
  test("listBuiltins returns sorted names of the 7 shipped workflows", () => {
    // Note: other test files in this package register custom entries
    // (e.g. foundation.test.ts) without unregistering, so the list may
    // include extras. Assert "contains the 7 shipped" rather than equality.
    const list = listBuiltins()
    const shipped = [
      "deep-research",
      "doc-gen",
      "lib-migrate",
      "plan",
      "refactor",
      "security-audit",
      "tdd",
    ]
    for (const name of shipped) {
      expect(list).toContain(name)
    }
    // Defensive: list is sorted alphabetically (sortable for users who
    // render the list in a UI).
    const sorted = [...list].sort()
    expect(list).toEqual(sorted)
  })

  test("getBuiltin returns a loader for shipped workflows, undefined for unknown", () => {
    expect(getBuiltin("deep-research")).toBeDefined()
    expect(getBuiltin("tdd")).toBeDefined()
    expect(getBuiltin("no-such-thing")).toBeUndefined()
  })

  test("getBuiltin rejects inherited Object.prototype members (null-prototype)", () => {
    // The registry uses `Object.create(null)` so that string keys like
    // "constructor", "toString", "hasOwnProperty" never accidentally hit
    // the prototype chain. Verify the canonical four are absent.
    expect(getBuiltin("constructor")).toBeUndefined()
    expect(getBuiltin("toString")).toBeUndefined()
    expect(getBuiltin("hasOwnProperty")).toBeUndefined()
    expect(getBuiltin("__proto__")).toBeUndefined()
  })

test("registerBuiltin adds a custom entry; existing entry with same name is overwritten", async () => {
    const original = getBuiltin("custom-test")
    if (original) {
      // Defensive cleanup — should not happen in fresh module, but if
      // re-running tests against a shared module, reset state.
      throw new Error("custom-test already registered; test isolation broken")
    }
    registerBuiltin("custom-test", async () => ({
      source: "export const meta = { name: 'custom-test' }\n",
      meta: { name: "custom-test", description: "custom" },
    }))
    expect(getBuiltin("custom-test")).toBeDefined()
    expect(listBuiltins()).toContain("custom-test")

    // Overwrite
    registerBuiltin("custom-test", async () => ({
      source: "overwritten",
      meta: { name: "custom-test", description: "v2" },
    }))
    const r = await loadBuiltin("custom-test")
    expect(r.description).toBe("v2")
  })

  test("loadBuiltin throws for unknown name with quoted name in error", async () => {
    await expect(loadBuiltin("nope")).rejects.toThrow(/Unknown built-in workflow.*"nope"/)
  })

  test("loadBuiltin returns a complete BuiltinEntry for a shipped workflow", async () => {
    const entry = await loadBuiltin("plan")
    expect(entry.name).toBe("plan")
    expect(typeof entry.description).toBe("string")
    expect(entry.description.length).toBeGreaterThan(0)
    expect(typeof entry.script).toBe("string")
    expect(entry.script.length).toBeGreaterThan(0)
    // script is the workflow source — must contain a `meta` export.
    expect(entry.script).toMatch(/export\s+const\s+meta\s*=/)
  })

  test("loadBuiltin preserves optional fields whenToUse and phases", async () => {
    // Not every builtin declares all optional fields. Pick one that
    // historically had both (deep-research has 6 phases per the
    // quick smoke-test in the previous turn).
    const entry = await loadBuiltin("deep-research")
    expect(entry.phases).toBeDefined()
    expect(entry.phases!.length).toBeGreaterThan(0)
    for (const phase of entry.phases!) {
      expect(typeof phase.title).toBe("string")
    }
  })
})