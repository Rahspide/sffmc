// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Phase-2 MEDIUM migration tests (v0.14.3) — sandbox pump timings (W17a-c).
//
// Verifies the new YAML-config getters for the concurrent pump in
// `sandbox.ts`:
//   - sandboxFastMs (default 1)
//   - sandboxSlowMs (default 50)
//   - sandboxFastWindow (default 50)
//
// The defaults match the prior hardcoded values exactly so behavior is
// unchanged when no `~/.config/SFFMC/workflow.yaml` is present.
//
// Scope: this commit ONLY adds the config field + getter + tests. The
// consumer wiring in `sandbox.ts` (replacing `FAST_MS = 1`, `SLOW_MS = 50`,
// `FAST_WINDOW = 50` with `getSandboxFastMs()` etc.) is tracked separately
// — runtime-adjacent files are touched in a follow-up hotfix commit.
//
// These tests verify the getter surface, not the consumer wiring.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"

import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  __setWorkflowConfig,
  getSandboxFastMs,
  getSandboxSlowMs,
  getSandboxFastWindow,
} from "./_test-helpers/config-cache.ts"

describe("@sffmc/workflow — Phase-2 W17a-c sandbox pump timings", () => {
  beforeEach(() => {
    __setWorkflowConfig(null)
  })

  afterEach(() => {
    __setWorkflowConfig(null)
  })

  it("W17a: DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastMs matches prior hardcoded 1", () => {
    // The prior hardcoded value was `const FAST_MS = 1` in sandbox.ts:248.
    // A drift here would mean the YAML override unintentionally changes
    // default behavior.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastMs).toBe(1)
  })

  it("W17b: DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxSlowMs matches prior hardcoded 50", () => {
    // The prior hardcoded value was `const SLOW_MS = 50` in sandbox.ts:249.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxSlowMs).toBe(50)
  })

  it("W17c: DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastWindow matches prior hardcoded 50", () => {
    // The prior hardcoded value was `const FAST_WINDOW = 50` in sandbox.ts:250.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastWindow).toBe(50)
  })

  it("getSandboxFastMs returns the default (1) when no YAML override is set", () => {
    expect(getSandboxFastMs()).toBe(1)
  })

  it("getSandboxSlowMs returns the default (50) when no YAML override is set", () => {
    expect(getSandboxSlowMs()).toBe(50)
  })

  it("getSandboxFastWindow returns the default (50) when no YAML override is set", () => {
    expect(getSandboxFastWindow()).toBe(50)
  })

  it("YAML override of sandboxFastMs propagates to getSandboxFastMs()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxFastMs: 5,
    })
    expect(getSandboxFastMs()).toBe(5)
    // Non-overridden sibling fields remain at default.
    expect(getSandboxSlowMs()).toBe(50)
    expect(getSandboxFastWindow()).toBe(50)
  })

  it("YAML override of sandboxSlowMs propagates to getSandboxSlowMs()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxSlowMs: 200,
    })
    expect(getSandboxSlowMs()).toBe(200)
    // Non-overridden sibling fields remain at default.
    expect(getSandboxFastMs()).toBe(1)
    expect(getSandboxFastWindow()).toBe(50)
  })

  it("YAML override of sandboxFastWindow propagates to getSandboxFastWindow()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxFastWindow: 100,
    })
    expect(getSandboxFastWindow()).toBe(100)
    // Non-overridden sibling fields remain at default.
    expect(getSandboxFastMs()).toBe(1)
    expect(getSandboxSlowMs()).toBe(50)
  })

  it("all three pump fields can be overridden together", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxFastMs: 2,
      sandboxSlowMs: 100,
      sandboxFastWindow: 25,
    })
    expect(getSandboxFastMs()).toBe(2)
    expect(getSandboxSlowMs()).toBe(100)
    expect(getSandboxFastWindow()).toBe(25)
  })

  it("__setWorkflowConfig(null) restores the default pump values", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxFastMs: 7,
      sandboxSlowMs: 77,
      sandboxFastWindow: 777,
    })
    expect(getSandboxFastMs()).toBe(7)
    expect(getSandboxSlowMs()).toBe(77)
    expect(getSandboxFastWindow()).toBe(777)

    __setWorkflowConfig(null)
    expect(getSandboxFastMs()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastMs)
    expect(getSandboxSlowMs()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxSlowMs)
    expect(getSandboxFastWindow()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxFastWindow)
  })
})
