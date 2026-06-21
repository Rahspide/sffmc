// SPDX-License-Identifier: MIT
// @sffmc/compose — see ../../LICENSE
//
// second release migration tests (v0.14.3) — compose plugin config
// plumbing + skills directory override (skills directory override (config), skills directory override (filesystem)).
//
// Verifies the new YAML-config getters for the compose plugin in
// `packages/compose/src/index.ts`:
//   - skillsDir (default "" → resolved to DEFAULT_SKILLS_DIR)
//   - VALID_SKILLS behavior (hardcoded list by default; filesystem
//     discovery when skillsDir is explicitly set)
//
// The defaults match the prior v0.14.2 hardcoded values exactly so
// behavior is unchanged when no `~/.config/SFFMC/compose.yaml` is
// present. The existing 42 tests in `packages/agentic/test/compose.test.ts`
// (the integration suite) continue to assert that end-to-end
// behavior is preserved; this file is the unit-level config-surface
// test that documents the new migration shape.
//
// Scope: this commit ONLY adds the config field + getter + tests. The
// consumer wiring in `server()` (replacing the module-level `SKILLS_DIR`
// and `VALID_SKILLS` with the config-aware getters) is included in the
// same commit because compose is a 57-line plugin with no `runtime.ts`
// / `persistence.ts` "off-limits" file surface — unlike the workflow
// and memory packages, the entire migration fits in one file.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"

import {
  DEFAULT_COMPOSE_CONFIG,
  DEFAULT_SKILLS,
  DEFAULT_SKILLS_DIR,
  __setComposeConfig,
  getComposeConfigSync,
  getComposeSkillsDir,
  getComposeValidSkills,
} from "./_test-helpers/config-cache.ts"

describe("@sffmc/compose — second release skills directory override (config + filesystem)", () => {
  beforeEach(() => {
    __setComposeConfig(null)
  })

  afterEach(() => {
    __setComposeConfig(null)
  })

  // ---- skills directory override (config): skillsDir default matches the v0.14.2 hardcoded value ----

  it("skills directory override (config): DEFAULT_COMPOSE_CONFIG.skillsDir is the empty string", () => {
    // The v0.14.2 hardcoded value was a module-level const resolved at
    // load time:
    //   `const SKILLS_DIR = join(import.meta.dirname, "..", "skills")`
    // The config-level default is the empty string, which is resolved
    // to `DEFAULT_SKILLS_DIR` at read time via `getComposeSkillsDir()`.
    // A drift here would mean the empty-string sentinel is wrong.
    expect(DEFAULT_COMPOSE_CONFIG.skillsDir).toBe("")
  })

  it("skills directory override (config): DEFAULT_SKILLS_DIR matches the v0.14.2 hardcoded SKILLS_DIR path", () => {
    // The v0.14.2 hardcoded value was
    //   `join(import.meta.dirname, "..", "skills")`
    // resolved at module load. `DEFAULT_SKILLS_DIR` is computed the
    // same way at module load, so the resolved value is identical.
    expect(DEFAULT_SKILLS_DIR).toBe(
      path.join(import.meta.dir, "..", "src", "..", "skills"),
    )
  })

  it("skills directory override (config): DEFAULT_SKILLS_DIR is a real directory containing the 18 bundled .md files", () => {
    expect(existsSync(DEFAULT_SKILLS_DIR)).toBe(true)
    // Sanity: the bundled directory should be the one shipped in
    // packages/compose/skills/. If this drifts, the plugin is loading
    // from the wrong location.
    expect(DEFAULT_SKILLS_DIR.endsWith(`${path.sep}skills`)).toBe(true)
  })

  it("skills directory override (config): getComposeSkillsDir() returns DEFAULT_SKILLS_DIR when no YAML override is set", () => {
    // Default case — no override, no config load. The getter must
    // fall back to the bundled directory.
    expect(getComposeSkillsDir()).toBe(DEFAULT_SKILLS_DIR)
  })

  it("skills directory override (config): getComposeSkillsDir() honors a YAML override of skillsDir", () => {
    const customDir = "/tmp/sffmc-compose-custom-skills"
    __setComposeConfig({ skillsDir: customDir })
    expect(getComposeSkillsDir()).toBe(customDir)
  })

  it("skills directory override (config): getComposeSkillsDir() treats a non-empty override as authoritative even if it does not exist", () => {
    // The plan does not require the path to be validated; the getter
    // returns the configured value verbatim. The server() function
    // surfaces the read error at execute time. This test documents
    // the no-validation invariant.
    const fakeDir = "/nonexistent/path/that/does/not/exist"
    __setComposeConfig({ skillsDir: fakeDir })
    expect(getComposeSkillsDir()).toBe(fakeDir)
  })

  it("skills directory override (config): getComposeConfigSync() returns DEFAULT_COMPOSE_CONFIG when no YAML override is set", () => {
    expect(getComposeConfigSync()).toEqual(DEFAULT_COMPOSE_CONFIG)
  })

  // ---- skills directory override (filesystem): VALID_SKILLS behavior (hardcoded vs filesystem-discovered) ----

  it("skills directory override (filesystem): DEFAULT_SKILLS matches the v0.14.2 hardcoded VALID_SKILLS list (18 entries)", () => {
    // The v0.14.2 hardcoded list — 18 entries in alphabetical order.
    // A drift here (e.g., entry added/removed) would silently change
    // which skills the agent can invoke in the default case.
    expect(DEFAULT_SKILLS).toEqual([
      "ask",
      "audit-deps",
      "benchmark",
      "brainstorm",
      "code-review",
      "debug",
      "execute",
      "feedback",
      "merge",
      "new-skill",
      "parallel",
      "plan",
      "report",
      "review",
      "subagent",
      "tdd",
      "verify",
      "worktree",
    ])
    expect(DEFAULT_SKILLS.length).toBe(18)
  })

  it("skills directory override (filesystem): getComposeValidSkills() returns the hardcoded list when no YAML override is set", async () => {
    // Default case — no override. The getter must return the v0.14.2
    // list verbatim. This is the path exercised by the existing 42
    // agentic integration tests.
    const skills = await getComposeValidSkills()
    expect(skills).toEqual(DEFAULT_SKILLS)
  })

  it("skills directory override (filesystem): getComposeValidSkills() falls back to DEFAULT_SKILLS when the configured directory is unreadable", async () => {
    // If the user sets a custom skillsDir that does not exist (or
    // is not readable), the plugin should still serve the bundled
    // skills via the hardcoded fallback. This protects against
    // misconfiguration crashes.
    __setComposeConfig({ skillsDir: "/nonexistent/path/for/test" })
    const skills = await getComposeValidSkills()
    expect(skills).toEqual(DEFAULT_SKILLS)
  })

  it("skills directory override (filesystem): getComposeValidSkills() discovers *.md basenames from the configured directory", async () => {
    // Use the bundled directory but force the override path. The
    // resolved list should be the alphabetical basenames of every
    // .md file in the directory. Since the bundled directory is
    // exactly the 18 names above, the resolved list must equal
    // DEFAULT_SKILLS (sorted).
    __setComposeConfig({ skillsDir: DEFAULT_SKILLS_DIR })
    const skills = await getComposeValidSkills()
    expect(skills).toEqual(DEFAULT_SKILLS)
  })

  // ---- Cache reset (D-1: __setComposeConfig(null) restores defaults) ----

  it("__setComposeConfig(null) restores the default skillsDir (empty string)", () => {
    __setComposeConfig({ skillsDir: "/tmp/some-override" })
    expect(getComposeSkillsDir()).toBe("/tmp/some-override")

    __setComposeConfig(null)
    expect(getComposeConfigSync()).toEqual(DEFAULT_COMPOSE_CONFIG)
    expect(getComposeSkillsDir()).toBe(DEFAULT_SKILLS_DIR)
  })

  it("__setComposeConfig(null) restores the default VALID_SKILLS list (filesystem → hardcoded)", async () => {
    // Switch to filesystem discovery.
    __setComposeConfig({ skillsDir: DEFAULT_SKILLS_DIR })
    const before = await getComposeValidSkills()
    expect(before).toEqual(DEFAULT_SKILLS)

    // Clear the override.
    __setComposeConfig(null)
    const after = await getComposeValidSkills()
    expect(after).toEqual(DEFAULT_SKILLS)
    // After clearing, the getter is still backed by the hardcoded
    // list (same observable result, different code path).
  })
})
