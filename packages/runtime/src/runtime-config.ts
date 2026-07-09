// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Runtime config state + lifecycle, extracted from WorkflowRuntime per the
// v0.16.0 refactor plan (ora-7, Phase 2). The WorkflowRuntime class holds
// a reference to a `RuntimeConfig` instance and delegates the public surface
// (setGracePeriodMs / setConfig / loadWorkflowConfig / resolveConfig) to it,
// preserving the public API while moving the implementation into a focused
// 150-LOC module.
//
// Why a class (not a module-level singleton):
// - The runtime-internal cache (workflowConfig + workflowConfigInjected +
//   workflowConfigPromise + gracePeriodMs) is per-runtime state. A class
//   with a one-time-per-runtime instance matches the existing per-runtime
//   lifecycle of WorkflowRuntime.
// - Tests that call `setConfig(null)` between cases get hermetic resets
//   by constructing a new RuntimeConfig — no module-level cache to leak
//   across tests.

import { loadConfig } from "@sffmc/utilities"
import {
  DEFAULT_GRACE_PERIOD_MS,
  MAX_GRACE_PERIOD_MS,
  getWorkflowConfigSync,
} from "./constants.ts"
import { DEFAULT_WORKFLOW_CONFIG, type WorkflowConfig } from "./types.ts"

export interface RuntimeConfigDeps {
  /** Optional ctx.config (the OpenCode provider's plugin config) — used as
   *  the legacy fallback when the runtime cache and the user YAML are both
   *  empty. The runtime keeps the ctx reference so resolveConfig() can
   *  read the fallback value at call-time (ctx can be mutated after
   *  construction in tests). */
  getCtxConfig: () => Partial<WorkflowConfig> | undefined
}

export class RuntimeConfig {
  /** workflow recovery grace period — in ms, set by index.ts config hook
   *  via `setGracePeriodMs()` or the test override. Stored on the config
   *  instance (not the runtime class) so `recoverOrphanedWorkflows()` can
   *  read it synchronously via `runtime.getGracePeriodMs()`. */
  private gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS
  /** SFFMC-loaded workflow config (maxSteps / maxTokens / maxWallClockMs /
   *  perStepTimeoutMs). Populated lazily by `loadWorkflowConfig()`. Tests
   *  inject via the constructor's `initial` parameter (sync, no YAML).
   *  Resolution order: cache → ctx.config (OpenCode provider) → defaults. */
  private workflowConfig: Required<WorkflowConfig> | null = null
  /** Flag to skip async YAML load when the test override is set. */
  private workflowConfigInjected: boolean = false
  /** In-flight promise cache for `loadWorkflowConfig()`. Prevents the TOCTOU
   *  race when `start()` and `resume()` are called concurrently. */
  private workflowConfigPromise: Promise<void> | null = null

  constructor(private readonly deps: RuntimeConfigDeps) {}

  /** workflow recovery grace period — validates integer 0..24h. */
  setGracePeriodMs(ms: number): void {
    if (!Number.isInteger(ms) || ms < 0 || ms > MAX_GRACE_PERIOD_MS) {
      throw new Error(
        `Invalid gracePeriodMs: ${ms} (must be integer 0..${MAX_GRACE_PERIOD_MS})`,
      )
    }
    this.gracePeriodMs = ms
  }

  /** Synchronously inject a workflow config. Used by tests via
   *  `RuntimeOpts.configOverride` to skip the async YAML load. Merges
   *  onto `DEFAULT_WORKFLOW_CONFIG` via spread so missing keys fall back
   *  to defaults, and new fields added to `WorkflowConfig` are auto-
   *  populated. When set, subsequent `loadWorkflowConfig()` calls are
   *  no-ops unless `null` is passed (which re-enables the YAML load). */
  setConfig(cfg: Partial<WorkflowConfig> | null): void {
    if (cfg === null) {
      this.workflowConfig = null
      this.workflowConfigInjected = false
      this.workflowConfigPromise = null
      return
    }
    this.workflowConfig = {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...cfg,
    } as Required<WorkflowConfig>
    this.workflowConfigInjected = true
  }

  /** Lazily load the SFFMC workflow config from `workflow.yaml`. Idempotent —
   *  concurrent callers all await the same in-flight promise (no TOCTOU race
   *  when `start()` and `resume()` run concurrently). No-op when the config
   *  was already injected (test override path). Called eagerly by
   *  `start()` / `resume()` before `resolveConfig()` runs. */
  async loadConfig(): Promise<void> {
    if (this.workflowConfigInjected) return
    if (this.workflowConfig !== null) return
    if (this.workflowConfigPromise) return this.workflowConfigPromise
    this.workflowConfigPromise = this.doLoad()
    return this.workflowConfigPromise
  }

  /** Internal YAML loader. Cached via `workflowConfigPromise` so concurrent
   *  callers share the same promise. Uses spread to populate every
   *  `WorkflowConfig` field from defaults, so new fields added to the
   *  interface are auto-included. */
  async doLoad(): Promise<void> {
    const loaded = await loadConfig<typeof DEFAULT_WORKFLOW_CONFIG>(
      "workflow",
      DEFAULT_WORKFLOW_CONFIG,
    )
    this.workflowConfig = {
      ...DEFAULT_WORKFLOW_CONFIG,
      ...loaded,
    } as Required<WorkflowConfig>
  }

  /** Resolve the effective workflow config for a step. Precedence:
   *  runtime-cached (YAML or test override) → ctx.config (OpenCode
   *  provider) → defaults. The extended config (maxDepth,
   *  maxLifecycleAgents) is read from the workflow-extended singleton. */
  resolve(
    perStepTimeoutMsOverride?: number,
  ): Required<WorkflowConfig> & { maxDepth: number; maxLifecycleAgents: number } {
    const ext = getWorkflowConfigSync()
    const src = this.workflowConfig ?? this.deps.getCtxConfig() ?? DEFAULT_WORKFLOW_CONFIG
    return {
      maxSteps: src.maxSteps ?? DEFAULT_WORKFLOW_CONFIG.maxSteps,
      maxTokens: src.maxTokens ?? DEFAULT_WORKFLOW_CONFIG.maxTokens,
      maxWallClockMs: src.maxWallClockMs ?? DEFAULT_WORKFLOW_CONFIG.maxWallClockMs,
      perStepTimeoutMs: perStepTimeoutMsOverride ?? src.perStepTimeoutMs ?? DEFAULT_WORKFLOW_CONFIG.perStepTimeoutMs,
      gracePeriodMs: this.gracePeriodMs,
      maxDepth: ext.maxDepth,
      maxLifecycleAgents: ext.maxLifecycleAgents,
    }
  }

  /** Test helper — reset the config to the empty state. */
  reset(): void {
    this.workflowConfig = null
    this.workflowConfigInjected = false
    this.workflowConfigPromise = null
    this.gracePeriodMs = DEFAULT_GRACE_PERIOD_MS
  }

  /** Read the current grace period. Used by the runtime's
   *  `recoverOrphanedWorkflows()` (synchronous read). */
  getGracePeriodMs(): number {
    return this.gracePeriodMs
  }
}
