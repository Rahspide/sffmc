// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

import { describe, it, expect, beforeEach } from "bun:test"
import { RuntimeConfig } from "../src/runtime-config.ts"
import { DEFAULT_GRACE_PERIOD_MS, MAX_GRACE_PERIOD_MS } from "../src/constants.ts"

describe("RuntimeConfig", () => {
  let ctxConfig: ReturnType<typeof RuntimeConfig.prototype.resolve> | undefined
  const deps = {
    getCtxConfig: () => ctxConfig,
  }
  let cfg: RuntimeConfig

  beforeEach(() => {
    ctxConfig = undefined
    cfg = new RuntimeConfig(deps)
  })

  // ── Grace period ─────────────────────────────────────────────────────

  describe("setGracePeriodMs", () => {
    it("accepts valid integer values", () => {
      cfg.setGracePeriodMs(0)
      expect(cfg.getGracePeriodMs()).toBe(0)
      cfg.setGracePeriodMs(MAX_GRACE_PERIOD_MS)
      expect(cfg.getGracePeriodMs()).toBe(MAX_GRACE_PERIOD_MS)
    })

    it("rejects negative values", () => {
      expect(() => cfg.setGracePeriodMs(-1)).toThrow(/Invalid gracePeriodMs/)
    })

    it("rejects non-integer values", () => {
      expect(() => cfg.setGracePeriodMs(1.5)).toThrow(/Invalid gracePeriodMs/)
    })

    it("rejects values above MAX_GRACE_PERIOD_MS", () => {
      expect(() => cfg.setGracePeriodMs(MAX_GRACE_PERIOD_MS + 1)).toThrow(/Invalid gracePeriodMs/)
    })

    it("defaults to DEFAULT_GRACE_PERIOD_MS", () => {
      expect(cfg.getGracePeriodMs()).toBe(DEFAULT_GRACE_PERIOD_MS)
    })
  })

  // ── setConfig (sync override) ────────────────────────────────────────

  describe("setConfig", () => {
    it("injects a partial config and overrides the cache", () => {
      cfg.setConfig({ maxSteps: 99 })
      const r = cfg.resolve()
      expect(r.maxSteps).toBe(99)
    })

    it("merges with defaults (spreads DEFAULT_WORKFLOW_CONFIG)", () => {
      cfg.setConfig({ maxSteps: 50 })
      const r = cfg.resolve()
      // Other fields fall through to defaults
      expect(r.maxTokens).toBeDefined()
      expect(r.maxWallClockMs).toBeDefined()
      expect(r.perStepTimeoutMs).toBeDefined()
    })

    it("setConfig(null) clears the override and re-enables YAML load", () => {
      cfg.setConfig({ maxSteps: 99 })
      expect(cfg.resolve().maxSteps).toBe(99)
      cfg.setConfig(null)
      // After clearing, ctx.config fallback applies (or defaults if ctx.config is undefined)
      const r = cfg.resolve()
      expect(r.maxSteps).not.toBe(99)
    })
  })

  // ── resolve precedence ───────────────────────────────────────────────

  describe("resolve", () => {
    it("precedence 1: cache (setConfig) wins over ctx.config and defaults", () => {
      ctxConfig = { maxSteps: 10 }
      cfg.setConfig({ maxSteps: 99 })
      const r = cfg.resolve()
      expect(r.maxSteps).toBe(99)
    })

    it("precedence 2: ctx.config fallback when cache is empty", () => {
      ctxConfig = { maxSteps: 42 }
      const r = cfg.resolve()
      expect(r.maxSteps).toBe(42)
    })

    it("precedence 3: defaults when both cache and ctx.config are empty", () => {
      const r = cfg.resolve()
      // DEFAULT_WORKFLOW_CONFIG.maxSteps is some positive integer
      expect(r.maxSteps).toBeGreaterThan(0)
    })

    it("perStepTimeoutMs override takes precedence over the resolved value", () => {
      cfg.setConfig({ perStepTimeoutMs: 5000 })
      const r = cfg.resolve(1000)
      expect(r.perStepTimeoutMs).toBe(1000)
    })

    it("perStepTimeoutMs without override falls through to cache → ctx.config → defaults", () => {
      ctxConfig = { perStepTimeoutMs: 7777 }
      const r = cfg.resolve()
      expect(r.perStepTimeoutMs).toBe(7777)
    })

    it("gracePeriodMs is the current grace value (not from cache/ctx.config)", () => {
      cfg.setGracePeriodMs(1234)
      const r = cfg.resolve()
      expect(r.gracePeriodMs).toBe(1234)
    })

    it("returns the extended config fields (maxDepth, maxLifecycleAgents) from the singleton", () => {
      const r = cfg.resolve()
      // Just verify they're present and positive
      expect(r.maxDepth).toBeGreaterThan(0)
      expect(r.maxLifecycleAgents).toBeGreaterThan(0)
    })
  })

  // ── loadConfig (async YAML) ──────────────────────────────────────────

  describe("loadConfig", () => {
    it("is a no-op when setConfig injected a config", async () => {
      cfg.setConfig({ maxSteps: 88 })
      await cfg.loadConfig()
      // Cache should still hold the injected value, not a loaded value
      expect(cfg.resolve().maxSteps).toBe(88)
    })

    it("is idempotent — concurrent calls share the in-flight promise", async () => {
      // No override set, so the loader path runs. Two concurrent calls
      // should not both invoke the loader; the second should hit the cache.
      // We don't have a direct way to count without spying; instead, verify
      // that the resolved value is stable across both calls.
      const p1 = cfg.loadConfig()
      const p2 = cfg.loadConfig()
      await Promise.all([p1, p2])
      const r1 = cfg.resolve()
      const r2 = cfg.resolve()
      expect(r1.maxSteps).toBe(r2.maxSteps)
    })

    // REGRESSION (v0.16.0, runtime-config): setConfig injected while
    // loadConfig is in-flight must not be overwritten by the YAML result.
    // Pre-fix: `setConfig` did not clear `workflowConfigPromise` and
    // `doLoad` did not re-check the injected flag after the await, so the
    // in-flight load clobbered the injected value on completion. The fix
    // adds a `if (this.workflowConfigInjected) return` guard after the
    // await in `doLoad` — this test pins that contract.
    it("REGRESSION: setConfig during in-flight loadConfig preserves the injected value", async () => {
      const cfg2 = new RuntimeConfig(deps)
      // Kick off the YAML load without awaiting. The Promise resolves on
      // the next microtask (loadConfig is `async`), giving us a window to
      // inject the override synchronously before the load completes.
      const loadPromise = cfg2.loadConfig()
      cfg2.setConfig({ maxSteps: 4242 })
      await loadPromise
      // Injected value must survive the YAML load completion.
      expect(cfg2.resolve().maxSteps).toBe(4242)
    })
  })

  // ── reset (test helper) ──────────────────────────────────────────────

  describe("reset", () => {
    it("restores the empty state", () => {
      cfg.setGracePeriodMs(9999)
      cfg.setConfig({ maxSteps: 100 })
      cfg.reset()
      expect(cfg.getGracePeriodMs()).toBe(DEFAULT_GRACE_PERIOD_MS)
      // After reset, resolve falls through to defaults
      const r = cfg.resolve()
      expect(r.maxSteps).not.toBe(100)
    })
  })
})
