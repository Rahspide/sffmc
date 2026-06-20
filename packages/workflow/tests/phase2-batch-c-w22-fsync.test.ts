// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Phase-2 MEDIUM migration tests (v0.14.3) — journal fsync coalescing (W22).
//
// Verifies the new YAML-config getter for the journal fsync coalesce
// window in `persistence.ts:scheduleFsync`:
//   - fsyncCoalesceMs (default 50)
//
// The default matches the prior hardcoded value exactly
// (`const FSYNC_COALESCE_MS = 50` in persistence.ts:171) so behavior is
// unchanged when no `~/.config/SFFMC/workflow.yaml` is present.
//
// Unlike W19, the consumer wiring in `persistence.ts` is NOT off-limits
// (persistence.ts is not runtime.ts). The follow-up hotfix that touches
// runtime.ts for W19 should also touch persistence.ts to replace
// `setTimeout(flushFsync, FSYNC_COALESCE_MS)` with
// `setTimeout(flushFsync, getFsyncCoalesceMs())`. This commit only adds
// the config field + getter + tests; the wiring update is tracked
// separately.
//
// These tests verify the getter surface and document the deferred
// wiring. They explicitly do NOT assert that persistence.ts uses the
// getter (it does not yet, per the migration ordering).

import { describe, it, expect, beforeEach, afterEach } from "bun:test"

import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  __setWorkflowConfig,
  getFsyncCoalesceMs,
} from "./_test-helpers/config-cache.ts"

describe("@sffmc/workflow — Phase-2 W22 journal fsync coalescing", () => {
  beforeEach(() => {
    __setWorkflowConfig(null)
  })

  afterEach(() => {
    __setWorkflowConfig(null)
  })

  it("W22: DEFAULT_WORKFLOW_EXTENDED_CONFIG.fsyncCoalesceMs matches prior hardcoded 50", () => {
    // The prior hardcoded value was `const FSYNC_COALESCE_MS = 50` in
    // persistence.ts:171. A drift here would mean the YAML override
    // unintentionally changes default behavior.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.fsyncCoalesceMs).toBe(50)
  })

  it("getFsyncCoalesceMs returns the default (50) when no YAML override is set", () => {
    expect(getFsyncCoalesceMs()).toBe(50)
  })

  it("YAML override of fsyncCoalesceMs propagates to getFsyncCoalesceMs()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      fsyncCoalesceMs: 100,
    })
    expect(getFsyncCoalesceMs()).toBe(100)
  })

  it("YAML override to a smaller value flows through unchanged", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      fsyncCoalesceMs: 10,
    })
    expect(getFsyncCoalesceMs()).toBe(10)
  })

  it("YAML override to a larger value flows through unchanged", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      fsyncCoalesceMs: 500,
    })
    expect(getFsyncCoalesceMs()).toBe(500)
  })

  it("W22 does not collide with W17a-c pump or W19 debounce defaults", () => {
    // Sibling fields remain at their respective defaults when only
    // fsyncCoalesceMs is overridden.
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      fsyncCoalesceMs: 200,
    })
    expect(getFsyncCoalesceMs()).toBe(200)
    // The pump and debounce defaults are still the v0.14.2 values.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastMs).toBe(1)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxSlowMs).toBe(50)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastWindow).toBe(50)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.flushDebounceMs).toBe(250)
  })

  it("__setWorkflowConfig(null) restores the default fsyncCoalesceMs (50)", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      fsyncCoalesceMs: 7,
    })
    expect(getFsyncCoalesceMs()).toBe(7)

    __setWorkflowConfig(null)
    expect(getFsyncCoalesceMs()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.fsyncCoalesceMs)
    expect(getFsyncCoalesceMs()).toBe(50)
  })
})
