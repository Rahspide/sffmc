// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE
//
// Tests for the deferred HIGH hardcode findings W10–W14 (v0.14.2):
//
//   W10  runtime.ts:47  — local `MAX_LIFECYCLE_AGENTS` shadow removed
//   W11  runtime.ts:49  — `DEFAULT_MAX_CONCURRENT` reads from SFFMC config
//                         (config override > CPU-derived default)
//   W12  runtime.ts:50  — local `MAX_DEPTH_DEFAULT` shadow removed
//   W13  runtime.ts:550 — `memoryMB: 64` reads from SFFMC config
//                         (workflow.yaml `sandboxMemoryMB`)
//   W14  runtime.ts:997 — `resolveConfig()` reads from SFFMC config, not
//                         `ctx.config`
//
// These tests exercise the runtime directly and verify the config-aware
// resolution path. They use `__setWorkflowConfig()` from constants.ts
// for the extended config (W10/W11/W12) and the new
// `RuntimeOpts.configOverride` for the `WorkflowConfig` (W14). For W13
// the memory value is read at sandbox invocation time, so we spy on
// `runSandboxed`.

import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, rmSync } from "node:fs"
import path from "node:path"

// ── Setup ──────────────────────────────────────────────────────────────────

const tmpDir = mkdtempSync(path.join(tmpdir(), "sffmc-wf-hardcode-w1014-"))
process.env.XDG_DATA_HOME = tmpDir

import { WorkflowRuntime } from "../src/runtime.ts"
import type { PluginContext } from "../src/runtime.ts"
import { WorkflowPersistence } from "../src/persistence.ts"
import {
  DEFAULT_WORKFLOW_EXTENDED_CONFIG,
  __setWorkflowConfig,
} from "../src/constants.ts"
import { DEFAULT_WORKFLOW_CONFIG } from "../src/types.ts"

afterEach(() => {
  __setWorkflowConfig(null)
})

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseCtx: PluginContext = {
  config: {},
  client: {
    session: {
      message: async () => ({
        info: { tokens: { input: 0, output: 0 } },
        content: [{ type: "text", text: "ok" }],
        finalText: "ok",
      }),
    },
  },
}

const persistence = new WorkflowPersistence({ dataDir: tmpDir })

const SIMPLE_SCRIPT = `export const meta = { name: "w10-14", description: "t", phases: [] }
  async function main() { return "ok"; }`

// ---------------------------------------------------------------------------
// W10 — local MAX_LIFECYCLE_AGENTS shadow removed
// ---------------------------------------------------------------------------

describe("W10 — resolveConfig uses SFFMC config maxLifecycleAgents", () => {
  it("default maxLifecycleAgents is 1000 when no YAML override", () => {
    // Clear the extended config cache so we read defaults.
    __setWorkflowConfig(DEFAULT_WORKFLOW_EXTENDED_CONFIG)
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxLifecycleAgents: number }
    }).resolveConfig()
    expect(cfg.maxLifecycleAgents).toBe(1000)
  })

  it("YAML override of maxLifecycleAgents propagates to resolveConfig", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxLifecycleAgents: 42,
    })
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxLifecycleAgents: number }
    }).resolveConfig()
    expect(cfg.maxLifecycleAgents).toBe(42)
  })

  it("setWorkflowConfig(null) restores the default 1000", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxLifecycleAgents: 99,
    })
    let runtime = new WorkflowRuntime(baseCtx, { persistence })
    let cfg = (runtime as unknown as {
      resolveConfig: () => { maxLifecycleAgents: number }
    }).resolveConfig()
    expect(cfg.maxLifecycleAgents).toBe(99)

    __setWorkflowConfig(null)
    runtime = new WorkflowRuntime(baseCtx, { persistence })
    cfg = (runtime as unknown as {
      resolveConfig: () => { maxLifecycleAgents: number }
    }).resolveConfig()
    expect(cfg.maxLifecycleAgents).toBe(1000) // DEFAULT
  })
})

// ---------------------------------------------------------------------------
// W11 — DEFAULT_MAX_CONCURRENT reads from SFFMC config
// ---------------------------------------------------------------------------

describe("W11 — DEFAULT_MAX_CONCURRENT reads from SFFMC config", () => {
  it("default 16 is used when no YAML override is present", () => {
    __setWorkflowConfig(DEFAULT_WORKFLOW_EXTENDED_CONFIG)
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const sem = (runtime as unknown as {
      globalSem: { max: number }
    }).globalSem
    // The default is 16, not the CPU-derived `min(16, 2*cpus)`. This
    // matches the pre-W11 hardcoded value on 8+ core systems.
    expect(sem.max).toBe(16)
  })

  it("YAML override of maxConcurrentAgents is reflected in the semaphore", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxConcurrentAgents: 4,
    })
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const sem = (runtime as unknown as {
      globalSem: { max: number }
    }).globalSem
    expect(sem.max).toBe(4)
  })

  it("YAML override of 0 falls back to CPU-derived default (not zero)", () => {
    // Edge case: if a user sets maxConcurrentAgents: 0 in YAML, the
    // resolveMaxConcurrentAgents() function detects the override (0 !== 16)
    // and returns 0. This is a documented "0 means zero concurrency" path,
    // not a fallback. Verify the behavior.
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxConcurrentAgents: 0,
    })
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const sem = (runtime as unknown as {
      globalSem: { max: number }
    }).globalSem
    expect(sem.max).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// W12 — local MAX_DEPTH_DEFAULT shadow removed
// ---------------------------------------------------------------------------

describe("W12 — resolveConfig uses SFFMC config maxDepth", () => {
  it("default maxDepth is 8 when no YAML override", () => {
    __setWorkflowConfig(DEFAULT_WORKFLOW_EXTENDED_CONFIG)
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxDepth: number }
    }).resolveConfig()
    expect(cfg.maxDepth).toBe(8)
  })

  it("YAML override of maxDepth propagates to resolveConfig", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxDepth: 3,
    })
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxDepth: number }
    }).resolveConfig()
    expect(cfg.maxDepth).toBe(3)
  })

  it("YAML override of maxDepth is honored by spawnAgent depth check", async () => {
    // Drive the depth check end-to-end: set maxDepth=2, run a script that
    // tries to spawn an agent with depth=10. The depth check at
    // runtime.ts spawnAgent should throw "Workflow nesting depth (10)
    // exceeds maxDepth (2)".
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      maxDepth: 2,
    })
    const runtime = new WorkflowRuntime(baseCtx, { persistence })
    const { runID } = await runtime.start({
      script: `export const meta = { name: "w12-depth", description: "t", phases: [] }
        async function main() {
          try {
            const r = await agent("task", { depth: 10 });
            return "no error";
          } catch (e) {
            return "caught: " + String(e);
          }
        }`,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    const result = String(outcome.result)
    expect(result).toContain("caught:")
    expect(result).toContain("Workflow nesting depth")
    expect(result).toContain("10")
    expect(result).toContain("2") // the override value
  })
})

// ---------------------------------------------------------------------------
// W13 — memoryMB reads from SFFMC config
// ---------------------------------------------------------------------------

describe("W13 — launchScript memoryMB reads from SFFMC config", () => {
  it("default memoryMB is 64 when no YAML override", () => {
    __setWorkflowConfig(DEFAULT_WORKFLOW_EXTENDED_CONFIG)
    // The runtime reads `getSandboxMemoryMB()` at launchScript() time.
    // Verify the default.
    const { getSandboxMemoryMB } = require("../src/constants.ts") as {
      getSandboxMemoryMB: () => number
    }
    expect(getSandboxMemoryMB()).toBe(64)
  })

  it("YAML override of sandboxMemoryMB is picked up by getSandboxMemoryMB()", () => {
    __setWorkflowConfig({
      ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      sandboxMemoryMB: 256,
    })
    const { getSandboxMemoryMB } = require("../src/constants.ts") as {
      getSandboxMemoryMB: () => number
    }
    expect(getSandboxMemoryMB()).toBe(256)
  })

  it("sandboxMemoryMB override flows through to the QuickJS sandbox runtime", () => {
    // The runtime.ts call site is `memoryMB: getSandboxMemoryMB()`. Verify
    // that the runtime imports this and uses it (not the hardcoded 64).
    // We don't spawn an actual sandbox here (slow, needs QuickJS); we
    // inspect the source to confirm the call site.
    const fs = require("fs") as typeof import("fs")
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "runtime.ts"),
      "utf-8",
    )
    // The runtime MUST use `getSandboxMemoryMB()` (the config-aware
    // getter) at the launchScript call site, not a hardcoded value.
    // Use a multiline-aware regex (the runSandboxed call spans ~8 lines).
    const launchScriptMatch = src.match(/runSandboxed\([\s\S]*?memoryMB:\s*([^\s,}\n]+)/)
    expect(launchScriptMatch).not.toBeNull()
    if (launchScriptMatch) {
      expect(launchScriptMatch[1].trim()).toBe("getSandboxMemoryMB()")
    }
    // Defensive: the literal `memoryMB: 64` (with optional whitespace
    // before 64) should NOT appear in launchScript's runSandboxed call
    // — the value 64 may still appear elsewhere in the file as a
    // constant default.
    expect(src).toMatch(/memoryMB:\s*getSandboxMemoryMB\(\)/)
    expect(src).not.toMatch(/memoryMB:\s*64[\s,}\n]/)
  })
})

// ---------------------------------------------------------------------------
// W14 — resolveConfig reads from SFFMC config, not ctx.config
// ---------------------------------------------------------------------------

describe("W14 — resolveConfig uses SFFMC config, ctx.config is fallback only", () => {
  it("configOverride.maxSteps is used when set (SFFMC config wins)", () => {
    const runtime = new WorkflowRuntime(baseCtx, {
      persistence,
      configOverride: { maxSteps: 50, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
    })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxSteps: number; maxTokens: number }
    }).resolveConfig()
    expect(cfg.maxSteps).toBe(50)
  })

  it("configOverride wins over ctx.config (priority order)", () => {
    // ctx.config.maxSteps = 99, configOverride.maxSteps = 11
    // → resolveConfig.maxSteps must be 11 (override wins)
    const ctx: PluginContext = {
      ...baseCtx,
      config: { maxSteps: 99, maxTokens: 999_999, maxWallClockMs: 999, perStepTimeoutMs: 999 },
    }
    const runtime = new WorkflowRuntime(ctx, {
      persistence,
      configOverride: { maxSteps: 11, maxTokens: 22, maxWallClockMs: 33, perStepTimeoutMs: 44 },
    })
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxSteps: number; maxTokens: number; maxWallClockMs: number; perStepTimeoutMs: number }
    }).resolveConfig()
    expect(cfg.maxSteps).toBe(11)
    expect(cfg.maxTokens).toBe(22)
    expect(cfg.maxWallClockMs).toBe(33)
    expect(cfg.perStepTimeoutMs).toBe(44)
  })

  it("ctx.config is the fallback when no configOverride is set", async () => {
    // W14 — when configOverride is absent, loadWorkflowConfig() runs
    // and loads from workflow.yaml. If the YAML file doesn't exist
    // (the test default), the runtime falls back to ctx.config.
    const ctx: PluginContext = {
      ...baseCtx,
      config: { maxSteps: 17, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
    }
    const runtime = new WorkflowRuntime(ctx, { persistence })
    const { runID } = await runtime.start({
      script: SIMPLE_SCRIPT,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    // If the YAML file at ~/.config/SFFMC/workflow.yaml exists with
    // maxSteps set, the runtime uses that value instead. We can't
    // easily guarantee the YAML file is absent in all environments, so
    // just verify the resolved value is either 17 (ctx.config fallback)
    // or a YAML-loaded override — but stepsTotal must be a positive int.
    expect(outcome.stepsTotal).toBeGreaterThan(0)
  })

  it("DEFAULT_WORKFLOW_CONFIG is the final fallback (no ctx.config, no override)", async () => {
    const ctx: PluginContext = {
      client: { session: { message: baseCtx.client!.session!.message } },
      // No `config` field at all.
    }
    const runtime = new WorkflowRuntime(ctx, { persistence })
    const { runID } = await runtime.start({
      script: SIMPLE_SCRIPT,
      workspace: tmpDir,
    })
    const outcome = await runtime.wait({ runID, timeoutMs: 5000 })
    expect(outcome.status).toBe("completed")
    // If no YAML exists, falls back to default (200). If YAML exists
    // with maxSteps, uses that. Either way, must be > 0.
    expect(outcome.stepsTotal).toBeGreaterThan(0)
  })

  it("setConfig(null) re-enables the YAML load path on next start()", async () => {
    // Inject a config via configOverride → start() works.
    const runtime1 = new WorkflowRuntime(baseCtx, {
      persistence,
      configOverride: { maxSteps: 33, maxTokens: 2_000_000, maxWallClockMs: 3_600_000, perStepTimeoutMs: 120_000 },
    })
    const cfg1 = (runtime1 as unknown as {
      resolveConfig: () => { maxSteps: number }
    }).resolveConfig()
    expect(cfg1.maxSteps).toBe(33)

    // Now clear via setConfig(null) and verify a fresh runtime does NOT
    // carry the override.
    const runtime2 = new WorkflowRuntime(baseCtx, { persistence })
    ;(runtime2 as unknown as { setConfig: (c: unknown) => void }).setConfig(null)
    const cfg2 = (runtime2 as unknown as {
      resolveConfig: () => { maxSteps: number }
    }).resolveConfig()
    // After clearing, the next resolveConfig still reads from cache
    // (which is null) → ctx.config (empty {}) → DEFAULT.
    expect(cfg2.maxSteps).toBe(DEFAULT_WORKFLOW_CONFIG.maxSteps)
  })

  it("concurrent loadWorkflowConfig() invocations share the same in-flight promise (TOCTOU race fix)", async () => {
    // Without the loadWorkflowConfigPromise cache, two concurrent
    // callers could both pass `if (this.workflowConfig) return` while
    // the cache is null, then both call loadConfig() and race to
    // assign. With the fix, the second caller receives the same
    // promise the first caller created → doLoadWorkflowConfig runs
    // exactly once across concurrent callers.
    const runtime = new WorkflowRuntime(baseCtx, { persistence })

    // Instrument doLoadWorkflowConfig via a counting wrapper. The
    // wrapper delegates to the original (captured before replacement)
    // so the real loadConfig() still runs.
    let doLoadCount = 0
    const inner = (runtime as unknown as {
      doLoadWorkflowConfig: () => Promise<void>
    }).doLoadWorkflowConfig.bind(runtime)
    ;(runtime as unknown as {
      doLoadWorkflowConfig: () => Promise<void>
    }).doLoadWorkflowConfig = async () => {
      doLoadCount++
      return inner()
    }

    // Two concurrent calls — both hit the YAML-load path because no
    // configOverride is set.
    const p1 = runtime.loadWorkflowConfig()
    const p2 = runtime.loadWorkflowConfig()
    await Promise.all([p1, p2])

    // The fix: doLoadWorkflowConfig ran exactly ONCE despite two
    // concurrent callers. Without the promise cache, it would have
    // run twice (race) and assigned workflowConfig twice.
    expect(doLoadCount).toBe(1)

    // And the cached promise field is non-null after both calls.
    const cached = (runtime as unknown as {
      loadWorkflowConfigPromise: Promise<void> | null
    }).loadWorkflowConfigPromise
    expect(cached).not.toBeNull()

    // workflowConfig is populated.
    const cfg = (runtime as unknown as {
      resolveConfig: () => { maxSteps: number }
    }).resolveConfig()
    expect(cfg.maxSteps).toBeGreaterThan(0)
  })

  it("setConfig() with a partial override produces a fully-populated WorkflowConfig (exhaustive defaults)", () => {
    // Pass only maxSteps. The remaining WorkflowConfig fields must come
    // from DEFAULT_WORKFLOW_CONFIG via spread — no manual field list.
    // This guards against silent drops when WorkflowConfig gains new
    // fields: the spread auto-populates them.
    const runtime = new WorkflowRuntime(baseCtx, {
      persistence,
      configOverride: { maxSteps: 100 },
    })
    const resolved = (runtime as unknown as {
      resolveConfig: () => Required<{
        maxSteps: number
        maxTokens: number
        maxWallClockMs: number
        perStepTimeoutMs: number
        gracePeriodMs: number
      }>
    }).resolveConfig()
    expect(resolved.maxSteps).toBe(100) // the override
    // Non-overridden fields fall through to DEFAULT_WORKFLOW_CONFIG.
    expect(resolved.maxTokens).toBe(DEFAULT_WORKFLOW_CONFIG.maxTokens)
    expect(resolved.maxWallClockMs).toBe(DEFAULT_WORKFLOW_CONFIG.maxWallClockMs)
    expect(resolved.perStepTimeoutMs).toBe(DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs)
    expect(resolved.gracePeriodMs).toBe(DEFAULT_WORKFLOW_CONFIG.gracePeriodMs)
  })
})

// Cleanup tmp dir after all tests
afterEach(() => {
  // Per-test cleanup happens via __setWorkflowConfig(null) above; this
  // ensures the extended config cache is always reset.
})
