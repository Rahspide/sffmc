// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Pure defaults: data shapes and constant values. No module-level side
// effects, no runtime config cache. Imported by `constants.ts` (barrel)
// and by `constants-config.ts` for the `DEFAULT_WORKFLOW_EXTENDED_CONFIG`
// fallback used by `getWorkflowConfigSync()`.

import type { SandboxConstraints } from "./types.ts"

/** 1h wall-clock for the sandbox. Matches maxWallClockMs to prevent
 *  mismatches where the sandbox runs 12x longer than the workflow.
 *
 *  Manriel workflow-recovery audit finding (2026-06-19): the 12h → 1h reduction is
 *  deliberate. The 12h value was NOT chosen for cleanup-after-kill;
 *  cleanup happens via `recoverOrphanedWorkflows()` + the workflow
 *  recovery grace period above (5 min default, 24h ceiling), which is the right
 *  abstraction for post-kill recovery. A 12h sandbox deadline would
 *  only mask runaway workflows and delay their failure signal.
 *
 *  Initial release migration: the runtime value can be overridden via
 *  `WorkflowConfig.scriptDeadlineMs`. The exported constant remains the
 *  default (and is still used directly by `runtime.ts` per the v0.14.x
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
 *  Initial release migration: the values can be overridden
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
 *  may be looked up by name. Order matters —  match wins. The
 *  `.sffmc/workflows` namespace is SFFMC's own; `.claude/workflows`
 *  is the legacy Claude convention for backward compatibility.
 *
 *  Initial release migration: the runtime value can be overridden via
 *  `WorkflowConfig.searchDirs`. The exported constant remains the default;
 *  `resolve.ts` reads the active value via `getWorkflowSearchDirs()`.
 */
export const WORKFLOW_SEARCH_DIRS = [".sffmc/workflows", ".claude/workflows"] as const

/** Hard cap on the total number of agents a workflow can spawn across
 *  its entire lifetime. Bounded so a buggy recursive workflow can't
 *  exhaust host resources.
 *
 *  Initial release migration: runtime.ts uses its own local copy of
 *  this constant (off-limits in v0.14.x per the v0.14.x hotfix policy).
 *  The override via `WorkflowConfig.maxLifecycleAgents` will take effect
 *  once runtime.ts is updated to read from config (tracked separately).
 */
export const MAX_LIFECYCLE_AGENTS = 1000

/** Default max nesting depth for nested workflow invocations. Beyond 8
 *  the call graph becomes too deep to reason about; users can override
 *  via the per-run config.
 *
 *  Initial release migration: same situation as MAX_LIFECYCLE_AGENTS
 *  — runtime.ts has a local copy (off-limits); override tracked
 *  separately.
 */
export const MAX_DEPTH_DEFAULT = 8

/** Grace period for `recoverOrphanedWorkflows()`. A workflow row left
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
//
//
// The schema below is loaded lazily via `loadConfig<>("workflow", …)` from
// `@sffmc/utilities`. Defaults match the exported constants above so behavior
// is unchanged when no `~/.config/SFFMC/workflow.yaml` is present. Callers
// that want config-aware values use the getter functions (`getScriptDeadlineMs`,
// `getSandboxMemoryMB`, …) — they prefer the YAML override and fall back to
// the hardcoded constant.
//
// values in `sandbox.ts` (FAST_MS=1, SLOW_MS=50, FAST_WINDOW=50). The pump
// is the BACKSTOP that drains guest microtasks while we await the guest
// promise — adaptive cadence to avoid idle CPU churn. A too-fast pump
// increases CPU without throughput gain; a too-slow pump adds latency.
// These are expert-only settings; the defaults are well-tuned.
// ---------------------------------------------------------------------------

export interface WorkflowExtendedConfig {
  /** Sandbox wall-clock deadline (ms). */
  scriptDeadlineMs: number
  /** Default sandbox memory (MiB). */
  sandboxMemoryMB: number
  /** QuickJS max instructions per sandbox run. */
  maxInstructions: number
  /** Max agents per workflow run. */
  maxSteps: number
  /** Token budget per workflow run. */
  maxTokens: number
  /** Wall-clock deadline per workflow run (ms). */
  maxWallClockMs: number
  /** Per-agent timeout (ms). */
  perStepTimeoutMs: number
  /** Total agents over workflow lifecycle. (runtime.ts uses
   *  a local copy; the override takes effect once runtime.ts is updated.) */
  maxLifecycleAgents: number
  /** Max nested workflow depth. (runtime.ts uses a local copy.) */
  maxDepth: number
  /** Global agent-concurrency cap. (runtime.ts uses a local
   *  `Math.min(16, 2 * cpus)` default; the override takes effect once
   *  runtime.ts is updated to read from config.) */
  maxConcurrentAgents: number
  /** QuickJS max stack size (bytes). */
  sandboxStackSize: number
  /** Saved-workflow search dirs (under workspace, walked upward). */
  searchDirs: readonly string[]
  /** Data directory override (default: XDG_DATA_HOME or
   *  ~/.local/share/SFFMC/workflow). Empty string means "use default". */
  dataDir: string
  /** sandbox pump fast interval — sandbox pump fast interval (ms). Adaptive pump cadence that
   *  drains guest microtasks; stays FAST right after finding work, decays
   *  to SLOW when idle. Expert-only. Default: 1. */
  sandboxFastMs: number
  /** sandbox pump slow interval — sandbox pump slow interval (ms). Idle pump cadence; worst
   *  case adds ≤ SLOW_MS latency when no work is found. Expert-only.
   *  Default: 50. */
  sandboxSlowMs: number
  /** sandbox pump decay window — number of idle ticks before the pump decays from FAST to
   *  SLOW cadence. Expert-only. Default: 50. */
  sandboxFastWindow: number
  /** scheduleFlush debounce window (ms). Coalesces frequent
   *  flushNow calls (one DB UPDATE per run) within this window.
   *
   *  v0.14.x hardcode  release: getter + field added NOW (per the sandbox pump timings
   *  pattern), but the consumer wiring in `runtime.ts:scheduleFlush`
   *  (replacing `setTimeout(..., 250)` with `getFlushDebounceMs()`) is
   *  DEFERRED — runtime.ts is off-limits per the v0.14.x hotfix policy.
   *  The override takes effect once runtime.ts is updated in a follow-up
   *  hotfix commit. Until then, the runtime uses the hardcoded 250
   *  regardless of YAML.
   *
   *  Default: 250 (matches the prior hardcoded value in runtime.ts). */
  flushDebounceMs: number
  /** fsync coalescing window (ms). High-frequency
   *  appendJournalSync callers (100+ events per workflow) would otherwise
   *  fsync per append, costing O(n) syscalls. Coalesce fsync calls
   *  within this window: each append schedules a deferred fsync that
   *  fires once per window across all tracked paths.
   *
   *  Note: unlike sandbox pump timings, the consumer wiring in `persistence.ts`
   *  is NOT off-limits — this commit replaces the literal
   *  `setTimeout(flushFsync, FSYNC_COALESCE_MS)` with
   *  `setTimeout(flushFsync, getFsyncCoalesceMs())`. The default
   *  matches the prior hardcoded 50. Default: 50. */
  fsyncCoalesceMs: number
  dbFilename: string
  scriptExt: string
  journalExt: string
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
  sandboxFastMs: 1,
  sandboxSlowMs: 50,
  sandboxFastWindow: 50,
  flushDebounceMs: 250,
  fsyncCoalesceMs: 50,
  dbFilename: "state.sqlite",
  scriptExt: ".js",
  journalExt: ".jsonl",
}
