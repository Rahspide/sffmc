// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// second release migration tests (v0.14.3) — scheduleFlush debounce (scheduleFlush debounce window).
//
// Verifies the new YAML-config getter for the scheduleFlush debounce
// window in `runtime.ts:scheduleFlush`:
//   - flushDebounceMs (default 250)
//
// The default matches the prior hardcoded value exactly (`setTimeout(..., 250)`
// in runtime.ts:1247) so behavior is unchanged when no
// `~/.config/SFFMC/workflow.yaml` is present.
//
// IMPORTANT: runtime.ts is OFF-LIMITS per the v0.14.1 hotfix policy.
// This commit ONLY adds the config field + getter + tests. The consumer
// wiring in `runtime.ts:scheduleFlush` (replacing the literal `250` with
// `getFlushDebounceMs()`) is DEFERRED to a follow-up hotfix commit.
// Until then, the runtime ignores YAML overrides for this field — the
// getter is exported but no production code in the workflow package
// currently consumes it.
//
// These tests verify the getter surface and document the deferred
// wiring. They explicitly do NOT assert that runtime.ts uses the getter
// (it does not, per the policy).

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  __setWorkflowConfig,
  getFlushDebounceMs,
} from "./_test-helpers/config-cache.ts"

describe("@sffmc/workflow — second release scheduleFlush debounce", () => {
  beforeEach(() => {
    __setWorkflowConfig(null)
  })

  afterEach(() => {
    __setWorkflowConfig(null)
  })

  it("scheduleFlush debounce window: DEFAULT_WORKFLOW_EXTENDED_CONFIG.flushDebounceMs matches prior hardcoded 250", () => {
    // The prior hardcoded value was `setTimeout(..., 250)` in
    // runtime.ts:1247 (`scheduleFlush` method).
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.flushDebounceMs).toBe(250)
  })

  it("getFlushDebounceMs returns the default (250) when no YAML override is set", () => {
    expect(getFlushDebounceMs()).toBe(250)
  })

  it("YAML override of flushDebounceMs propagates to getFlushDebounceMs()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      flushDebounceMs: 100,
    })
    expect(getFlushDebounceMs()).toBe(100)
  })

  it("YAML override to a larger value flows through unchanged", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      flushDebounceMs: 1000,
    })
    expect(getFlushDebounceMs()).toBe(1000)
  })

  it("__setWorkflowConfig(null) restores the default flushDebounceMs (250)", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      flushDebounceMs: 50,
    })
    expect(getFlushDebounceMs()).toBe(50)

    __setWorkflowConfig(null)
    expect(getFlushDebounceMs()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.flushDebounceMs)
    expect(getFlushDebounceMs()).toBe(250)
  })

  it("Documented: runtime.ts still uses the hardcoded 250 — deferred wiring per v0.14.1 policy", () => {
    // This test asserts the CURRENT (v0.14.3 second release Batch C) state.
    // It will need to be updated when runtime.ts is migrated in a
    // follow-up hotfix commit.
    //
    // The deferred-wiring check: the literal `setTimeout(..., 250)` is
    // still present in runtime.ts:scheduleFlush. Once runtime.ts is
    // updated, this test should be removed and a new test should verify
    // `setTimeout(..., getFlushDebounceMs())` instead.
    const runtimePath = path.join(__dirname, "..", "src", "runtime.ts")
    expect(existsSync(runtimePath)).toBe(true)
    const src = readFileSync(runtimePath, "utf-8")
    // Locate the scheduleFlush method definition (not the call sites).
    const scheduleFlushIdx = src.indexOf("private scheduleFlush(")
    expect(scheduleFlushIdx).toBeGreaterThan(-1)
    // Slice from the method definition onward and look for the closing
    // `}, 250)` — that's the setTimeout's debounce literal.
    const after = src.slice(scheduleFlushIdx, scheduleFlushIdx + 400)
    expect(after).toMatch(/\}\s*,\s*250\s*\)/)
    // Defensive: the getter should NOT appear in the scheduleFlush body yet.
    expect(after).not.toContain("getFlushDebounceMs()")
  })
})
