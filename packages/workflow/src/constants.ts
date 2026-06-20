// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

// Shared runtime constants used by both `types.ts` and `runtime.ts`.
// Extracted into a dedicated module to break the original
//   types.ts  <->  runtime.ts
// circular import, which caused a TDZ ReferenceError on
// `SCRIPT_DEADLINE_MS` in user environments (5 tests failing in
// `bun test` whenever runtime.ts happened to load first).

import type { SandboxConstraints } from "./types.ts"
import { loadConfig } from "@sffmc/shared"

/** 1h wall-clock for the sandbox. Matches maxWallClockMs to prevent
 *  mismatches where the sandbox runs 12x longer than the workflow.
 *
 *  Manriel H5 design rationale (2026-06-19): the 12h → 1h reduction is
 *  deliberate. The 12h value was NOT chosen for cleanup-after-kill;
 *  cleanup happens via `recoverOrphanedWorkflows()` + the H5 grace
 *  period above (5 min default, 24h ceiling), which is the right
 *  abstraction for post-kill recovery. A 12h sandbox deadline would
 *  only mask runaway workflows and delay their failure signal.
 *
 *  Phase-1 HIGH migration (W1): the runtime value can be overridden via
 *  `WorkflowConfig.scriptDeadlineMs`. The exported constant remains the
 *  default (and is still used directly by `runtime.ts` per the v0.14.1
 *  hotfix policy — runtime.ts is off-limits to this migration, so the
 *  override only takes effect through the getter `getScriptDeadlineMs()`).
 */
export const SCRIPT_DEADLINE_MS = 60 * 60 * 1000 // 1h

export const DEFAULT_SANDBOX_CONSTRAINTS: SandboxConstraints = {
  memoryMB: 64,
  maxInstructions: 5_000_000,
  deadlineMs: SCRIPT_DEADLINE_MS,
}

/** Single source of truth for workflow budget defaults.
 *  Used by BOTH `types.ts` (DEFAULT_WORKFLOW_CONFIG) and `schema.ts`
 *  (SCHEMA_SQL column defaults). Drift between TS and SQL is a hardcode
 *  hazard — changing one without the other silently changes effective
 *  caps based on whether rows pre-existed.
 *
 *  Phase-1 HIGH migration (W4, W5, W6, W7): the values can be overridden
 *  via `WorkflowConfig.maxSteps`, `maxTokens`, `maxWallClockMs`,
 *  `perStepTimeoutMs`. The exported constants remain the defaults and
 *  are still used directly by `runtime.ts` (off-limits). The overrides
 *  take effect through the getter `getWorkflowLimits()`.
 */
export const WORKFLOW_LIMITS = {
  maxSteps: 200,
  maxTokens: 2_000_000,
  maxWallClockMs: 3_600_000, // 1 hour
  perStepTimeoutMs: 120_000, // 2 minutes
} as const

/** Directories (under the workspace, walked upward) where saved workflows
 *  may be looked up by name. Order matters — first match wins. The
 *  `.sffmc/workflows` namespace is SFFMC's own; `.claude/workflows`
 *  is the legacy Claude convention for backward compatibility.
 *
 *  Phase-1 HIGH migration (W25): the runtime value can be overridden via
 *  `WorkflowConfig.searchDirs`. The exported constant remains the default;
 *  `resolve.ts` reads the active value via `getWorkflowSearchDirs()`.
 */
export const WORKFLOW_SEARCH_DIRS = [".sffmc/workflows", ".claude/workflows"] as const

/** Hard cap on the total number of agents a workflow can spawn across
 *  its entire lifetime. Bounded so a buggy recursive workflow can't
 *  exhaust host resources.
 *
 *  Phase-1 HIGH migration (W8): runtime.ts uses its own local copy of
 *  this constant (off-limits in v0.14.2 per the v0.14.1 hotfix policy).
 *  The override via `WorkflowConfig.maxLifecycleAgents` will take effect
 *  once runtime.ts is updated to read from config (tracked separately).
 */
export const MAX_LIFECYCLE_AGENTS = 1000

/** Default max nesting depth for nested workflow invocations. Beyond 8
 *  the call graph becomes too deep to reason about; users can override
 *  via the per-run config.
 *
 *  Phase-1 HIGH migration (W9): same situation as MAX_LIFECYCLE_AGENTS
 *  — runtime.ts has a local copy (off-limits); override tracked
 *  separately.
 */
export const MAX_DEPTH_DEFAULT = 8

/** H5 — grace period for `recoverOrphanedWorkflows()`. A workflow row left
 *  in 'running' status with `time_created` within this window is treated as
 *  "process restarted, possibly recoverable" → marked 'paused' regardless
 *  of journal presence. Past the window, the journal-presence check
 *  decides. Default 5 minutes covers plugin-reload, VS Code hot-reload,
 *  and the typical OS reboot (see v0.14 design §3.2). */
export const DEFAULT_GRACE_PERIOD_MS = 5 * 60 * 1000

/** Maximum grace period the user can configure. 24h is the absolute cap
 *  so even an absurd operator setting can't make workflows live forever.
 *  Validation in `WorkflowRuntime` constructor throws above this. */
export const MAX_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// Phase-1 HIGH migration (W1, W2, W3, W4, W5, W6, W7, W8, W9, W11, W15, W16,
// W20, W25) — YAML-configurable workflow limits.
//
// The schema below is loaded lazily via `loadConfig<>("workflow", …)` from
// `@sffmc/shared`. Defaults match the exported constants above so behavior
// is unchanged when no `~/.config/SFFMC/workflow.yaml` is present. Callers
// that want config-aware values use the getter functions (`getScriptDeadlineMs`,
// `getSandboxMemoryMB`, …) — they prefer the YAML override and fall back to
// the hardcoded constant.
// ---------------------------------------------------------------------------

export interface WorkflowExtendedConfig {
  /** W1 — sandbox wall-clock deadline (ms). */
  scriptDeadlineMs: number
  /** W2 / W13 / W15 — default sandbox memory (MiB). */
  sandboxMemoryMB: number
  /** W3 — QuickJS max instructions per sandbox run. */
  maxInstructions: number
  /** W4 — max agents per workflow run. */
  maxSteps: number
  /** W5 — token budget per workflow run. */
  maxTokens: number
  /** W6 — wall-clock deadline per workflow run (ms). */
  maxWallClockMs: number
  /** W7 — per-agent timeout (ms). */
  perStepTimeoutMs: number
  /** W8 / W10 — total agents over workflow lifecycle. (runtime.ts uses
   *  a local copy; the override takes effect once runtime.ts is updated.) */
  maxLifecycleAgents: number
  /** W9 / W12 — max nested workflow depth. (runtime.ts uses a local copy.) */
  maxDepth: number
  /** W11 — global agent-concurrency cap. (runtime.ts uses a local
   *  `Math.min(16, 2 * cpus)` default; the override takes effect once
   *  runtime.ts is updated to read from config.) */
  maxConcurrentAgents: number
  /** W16 — QuickJS max stack size (bytes). */
  sandboxStackSize: number
  /** W25 — saved-workflow search dirs (under workspace, walked upward). */
  searchDirs: readonly string[]
  /** W20 — data directory override (default: XDG_DATA_HOME or
   *  ~/.local/share/SFFMC/workflow). Empty string means "use default". */
  dataDir: string
}

export const DEFAULT_WORKFLOW_EXTENDED_CONFIG: WorkflowExtendedConfig = {
  scriptDeadlineMs: SCRIPT_DEADLINE_MS,
  sandboxMemoryMB: 64,
  maxInstructions: 5_000_000,
  maxSteps: WORKFLOW_LIMITS.maxSteps,
  maxTokens: WORKFLOW_LIMITS.maxTokens,
  maxWallClockMs: WORKFLOW_LIMITS.maxWallClockMs,
  perStepTimeoutMs: WORKFLOW_LIMITS.perStepTimeoutMs,
  maxLifecycleAgents: MAX_LIFECYCLE_AGENTS,
  maxDepth: MAX_DEPTH_DEFAULT,
  maxConcurrentAgents: 16,
  sandboxStackSize: 1024 * 1024, // 1 MiB
  searchDirs: WORKFLOW_SEARCH_DIRS,
  dataDir: "",
}

// Module-level cache for the loaded config. Populated on first call to
// `ensureWorkflowConfig()`. Sync getters fall back to defaults until then.
let _workflowConfig: WorkflowExtendedConfig | null = null
let _workflowConfigPromise: Promise<WorkflowExtendedConfig> | null = null

/** Load `~/.config/SFFMC/workflow.yaml` once and cache the result.
 *  Idempotent — concurrent callers receive the same promise.
 *
 *  @param opts.configHome — override the config directory (useful for
 *    tests that need an isolated config file). Defaults to
 *    `~/.config/SFFMC`. */
export function ensureWorkflowConfig(
  opts?: { configHome?: string },
): Promise<WorkflowExtendedConfig> {
  if (_workflowConfig) return Promise.resolve(_workflowConfig)
  if (!_workflowConfigPromise) {
    _workflowConfigPromise = loadConfig<Partial<WorkflowExtendedConfig>>(
      "workflow",
      DEFAULT_WORKFLOW_EXTENDED_CONFIG,
      { configHome: opts?.configHome },
    ).then((loaded) => {
      const merged: WorkflowExtendedConfig = {
        ...DEFAULT_WORKFLOW_EXTENDED_CONFIG,
        ...loaded,
      }
      _workflowConfig = merged
      return merged
    })
  }
  return _workflowConfigPromise
}

/** Test helper — reset the cached config. Useful for unit tests that
 *  want to inject a custom config without round-tripping through YAML. */
export function __setWorkflowConfig(cfg: WorkflowExtendedConfig | null): void {
  _workflowConfig = cfg
  _workflowConfigPromise = null
}

/** Sync accessor — returns the cached config or the defaults if the
 *  YAML hasn't been loaded yet. Use this in hot paths where awaiting is
 *  not an option; call `ensureWorkflowConfig()` at startup to populate. */
export function getWorkflowConfigSync(): WorkflowExtendedConfig {
  return _workflowConfig ?? DEFAULT_WORKFLOW_EXTENDED_CONFIG
}

// Config-aware getters. Each prefers the YAML override and falls back to
// the exported module-level constant (the prior hardcoded value).

export function getScriptDeadlineMs(): number {
  return getWorkflowConfigSync().scriptDeadlineMs
}

export function getSandboxMemoryMB(): number {
  return getWorkflowConfigSync().sandboxMemoryMB
}

export function getSandboxStackSize(): number {
  return getWorkflowConfigSync().sandboxStackSize
}

export function getWorkflowSearchDirs(): readonly string[] {
  return getWorkflowConfigSync().searchDirs
}

export function getWorkflowDataDir(): string {
  return getWorkflowConfigSync().dataDir
}

export function getMaxInstructions(): number {
  return getWorkflowConfigSync().maxInstructions
}

export function getMaxConcurrentAgents(): number {
  return getWorkflowConfigSync().maxConcurrentAgents
}
