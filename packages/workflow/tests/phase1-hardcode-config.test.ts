// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// initial release HIGH migration tests (v0.14.2). Verifies the new YAML-config
// getters in the workflow-constants module:
//   - DEFAULT_WORKFLOW_EXTENDED_CONFIG has the prior hardcoded values
//   - getWorkflowConfigSync() returns defaults before any YAML load
//   - ensureWorkflowConfig() merges YAML overrides onto defaults
//   - getter helpers prefer the cached YAML value
//   - the test helper __setWorkflowConfig() can inject a custom config
//
// These tests do NOT touch the runtime.ts-internal constants
// (MAX_LIFECYCLE_AGENTS / MAX_DEPTH_DEFAULT) — those are deferred per the
// v0.14.1 hotfix policy.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { resolve } from "node:path"

// Use a temp config dir for the YAML. We pass `configHome` explicitly to
// ensureWorkflowConfig() (loadConfig uses node:os.homedir() which does NOT
// respect process.env.HOME on Bun), so we don't need to override HOME.
const tmpHome = mkdtempSync(resolve(tmpdir(), "sffmc-workflow-yaml-test-"))
const configDir = resolve(tmpHome, ".config", "SFFMC")

// Track HOME so we can restore it in afterAll — other test files (e.g.
// dream.test.ts #15) read process.env.HOME to compute their archive path.
// If we leave HOME mutated, those tests fail with ENOENT.
const ORIGINAL_HOME = process.env.HOME

beforeAll(() => {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true })
})

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true })
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
})

// v0.14.3 D-1 — every workflow-config import now goes through the
// test-helper shim so production code can never accidentally depend
// on `__setWorkflowConfig` (which is no longer exported from src/).
import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  SCRIPT_DEADLINE_MS,
  WORKFLOW_LIMITS,
  WORKFLOW_SEARCH_DIRS,
  MAX_LIFECYCLE_AGENTS,
  MAX_DEPTH_DEFAULT,
  ensureWorkflowConfig,
  getWorkflowConfigSync,
  __setWorkflowConfig,
  getScriptDeadlineMs,
  getSandboxMemoryMB,
  getSandboxStackSize,
  getWorkflowSearchDirs,
  getWorkflowDataDir,
  getMaxConcurrentAgents,
} from "./_test-helpers/config-cache.ts"

describe("@sffmc/workflow — initial release HIGH migration config-loading path", () => {
  beforeEach(() => {
    // Reset cache between tests so each test sees a clean config.
    __setWorkflowConfig(null)
  })

  afterEach(() => {
    __setWorkflowConfig(null)
  })

  it("DEFAULT_WORKFLOW_EXTENDED_CONFIG matches prior hardcoded values (no behavior change)", () => {
    // Each of these defaults must match the values that were hardcoded
    // in constants.ts / sandbox.ts before initial release. A drift here would
    // mean the YAML override unintentionally changes behavior.
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptDeadlineMs).toBe(SCRIPT_DEADLINE_MS)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptDeadlineMs).toBe(60 * 60 * 1000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxMemoryMB).toBe(64)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxInstructions).toBe(5_000_000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxSteps).toBe(WORKFLOW_LIMITS.maxSteps)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxSteps).toBe(200)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxTokens).toBe(WORKFLOW_LIMITS.maxTokens)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxTokens).toBe(2_000_000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxWallClockMs).toBe(WORKFLOW_LIMITS.maxWallClockMs)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxWallClockMs).toBe(3_600_000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.perStepTimeoutMs).toBe(WORKFLOW_LIMITS.perStepTimeoutMs)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.perStepTimeoutMs).toBe(120_000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxLifecycleAgents).toBe(MAX_LIFECYCLE_AGENTS)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxLifecycleAgents).toBe(1000)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxDepth).toBe(MAX_DEPTH_DEFAULT)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxDepth).toBe(8)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.maxConcurrentAgents).toBe(16)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.sandboxStackSize).toBe(1024 * 1024)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.searchDirs).toEqual(WORKFLOW_SEARCH_DIRS)
    expect(DEFAULT_WORKFLOW_EXTENDED_CONFIG.dataDir).toBe("")
  })

  it("getWorkflowConfigSync returns defaults before any YAML load (sync getter)", () => {
    // __setWorkflowConfig(null) above ensures the cache is empty.
    const cfg = getWorkflowConfigSync()
    expect(cfg.scriptDeadlineMs).toBe(60 * 60 * 1000)
    expect(cfg.sandboxMemoryMB).toBe(64)
    expect(cfg.searchDirs).toEqual([".sffmc/workflows", ".claude/workflows"])
  })

  it("getter helpers prefer cached config over defaults", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      scriptDeadlineMs: 1234,
      sandboxMemoryMB: 7,
      sandboxStackSize: 42,
      searchDirs: [".custom/workflows"],
      dataDir: "/tmp/data",
      maxConcurrentAgents: 99,
    })
    expect(getScriptDeadlineMs()).toBe(1234)
    expect(getSandboxMemoryMB()).toBe(7)
    expect(getSandboxStackSize()).toBe(42)
    expect(getWorkflowSearchDirs()).toEqual([".custom/workflows"])
    expect(getWorkflowDataDir()).toBe("/tmp/data")
    expect(getMaxConcurrentAgents()).toBe(99)
  })

  it("ensureWorkflowConfig reads YAML overrides from ~/.config/SFFMC/workflow.yaml", async () => {
    // Write a YAML with one override to confirm loadConfig merges onto defaults.
    writeFileSync(
      resolve(configDir, "workflow.yaml"),
      [
        "scriptDeadlineMs: 7777",
        "sandboxMemoryMB: 128",
        "sandboxStackSize: 2097152",
        "searchDirs:",
        "  - .alt/workflows",
        "  - .legacy/workflows",
        "dataDir: /var/lib/sffmc-test",
        "maxConcurrentAgents: 32",
        "",
      ].join("\n"),
      "utf-8",
    )

    // Pass configHome explicitly because loadConfig uses node:os.homedir()
    // which does NOT respect process.env.HOME on Bun.
    const cfg = await ensureWorkflowConfig({ configHome: configDir })
    // Overridden keys:
    expect(cfg.scriptDeadlineMs).toBe(7777)
    expect(cfg.sandboxMemoryMB).toBe(128)
    expect(cfg.sandboxStackSize).toBe(2097152)
    expect(cfg.searchDirs).toEqual([".alt/workflows", ".legacy/workflows"])
    expect(cfg.dataDir).toBe("/var/lib/sffmc-test")
    expect(cfg.maxConcurrentAgents).toBe(32)
    // Non-overridden keys retain defaults:
    expect(cfg.maxSteps).toBe(200)
    expect(cfg.maxTokens).toBe(2_000_000)
    expect(cfg.maxLifecycleAgents).toBe(1000)
    expect(cfg.maxDepth).toBe(8)
  })

  it("ensureWorkflowConfig is idempotent (cached after first call)", async () => {
    const cfg1 = await ensureWorkflowConfig()
    const cfg2 = await ensureWorkflowConfig()
    // Same reference — the second call returns the cached object.
    expect(cfg1).toBe(cfg2)
  })

  it("__setWorkflowConfig(null) resets the cache (test isolation)", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      scriptDeadlineMs: 5555,
    })
    expect(getScriptDeadlineMs()).toBe(5555)
    __setWorkflowConfig(null)
    expect(getScriptDeadlineMs()).toBe(DEFAULT_WORKFLOW_EXTENDED_CONFIG.scriptDeadlineMs)
  })
})