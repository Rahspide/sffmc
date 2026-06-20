// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE
//
// Houses three opt-in sub-features: checkpoint, judge, dream.
// Each can be composed individually by @sffmc/memory MSP, or all
// three can be loaded together via this package's default export
// (standalone usage).
//
// Phase 2 (v0.9.0): factory pattern replaced with named server
// exports so the memory MSP can compose them via runtime hook().

import { loadConfig, mergeHooks, type PluginContext, createLogger, type PluginServer } from "@sffmc/shared";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCheckpointTool } from "./checkpoint";
import { createJudgeTool, DEFAULT_RUBRIC } from "./judge";
import { createDreamTool } from "./dream";

const log = createLogger("extra");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ExtraConfig {
  checkpoint: boolean;
  judge: boolean;
  dream: boolean;
  dream_threshold: number;
  dream_interval_hours: number;
  judge_model: string;
  judge_rubric: string;
  judge_auto: boolean;
  checkpoint_dir: string;
  // Phase-1 (v0.14.2) HIGH-severity migration — see .slim/deepwork/hardcode-audit-2026-06.md
  /** E1 — max checkpoint file size in bytes (default 10 MiB). */
  checkpoint_max_file_size: number;
  /** E2 — max messages restored from a single checkpoint (default 50). */
  checkpoint_max_restored_messages: number;
  // Phase-2 (v0.14.3) MEDIUM-severity migration — see
  // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.3
  /** E3 — buffer flush threshold (tool calls buffered before disk flush). */
  checkpoint_flush_threshold: number;
  /** E4 — periodic flush interval in ms. */
  checkpoint_flush_interval_ms: number;
  /** E5 — max in-memory session buffers (LRU eviction when exceeded). */
  checkpoint_max_buffered_sessions: number;
  /** E7 — Jaccard dedup threshold for dream (default 0.9). */
  dream_dedup_threshold: number;
  /** E8 — Jaccard cluster threshold for dream (default 0.3). */
  dream_cluster_threshold: number;
  /** E9 — max entries processed per dream cycle (default 5000). */
  dream_max_entries: number;
  /** E10 — JSONL path for archived dream entries. Empty string means
   *  "use the homedir default" (`~/.local/share/sffmc/extra/dream-archive.jsonl`). */
  dream_archive_path: string;
  /** E15 — max candidates per judge call. Validated to the 2-20 range. */
  judge_max_candidates: number;
}

const defaultConfig: ExtraConfig = {
  checkpoint: false,
  judge: false,
  dream: false,
  dream_threshold: 50,
  dream_interval_hours: 24,
  judge_model: "",
  judge_rubric: DEFAULT_RUBRIC,
  judge_auto: false,
  checkpoint_dir: "", // resolved at server time if empty
  // Defaults match the prior hardcoded values — behavior unchanged.
  checkpoint_max_file_size: 10 * 1024 * 1024, // E1: 10 MiB
  checkpoint_max_restored_messages: 50,        // E2
  checkpoint_flush_threshold: 50,              // E3
  checkpoint_flush_interval_ms: 5_000,         // E4
  checkpoint_max_buffered_sessions: 50,        // E5
  dream_dedup_threshold: 0.9,                  // E7
  dream_cluster_threshold: 0.3,                // E8
  dream_max_entries: 5000,                     // E9
  dream_archive_path: "",                      // E10: empty → DEFAULT_ARCHIVE_PATH
  judge_max_candidates: 8,                     // E15
};

const DEFAULT_CHECKPOINT_DIR = join(
  homedir(),
  ".local",
  "share",
  "sffmc",
  "extra",
  "checkpoints",
);

// ---------------------------------------------------------------------------
// Named servers (for composition by @sffmc/memory MSP)
// ---------------------------------------------------------------------------

export const id = "@sffmc/extra";

// Cache the config once so the three sub-feature servers don't each re-parse
// the same file. They share the same ExtraConfig and call factories with
// overlapping fields — a single read is enough.
let _sharedConfig: ExtraConfig | undefined;

export const checkpointServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await getConfig();
  const resolvedCheckpointDir = config.checkpoint_dir || DEFAULT_CHECKPOINT_DIR;
  log.info(
    `checkpoint: ${config.checkpoint ? "enabled" : "disabled"}`,
  );
  // Phase-1 HIGH migration (E1, E2) + Phase-2 MEDIUM migration (E3, E4, E5):
  // forward YAML-configurable limits to the checkpoint factory. Defaults
  // match the previous hardcoded values, so behavior is unchanged when no
  // YAML is present.
  const cp = createCheckpointTool({
    enabled: config.checkpoint,
    dir: resolvedCheckpointDir,
    maxFileSize: config.checkpoint_max_file_size,
    maxRestoredMessages: config.checkpoint_max_restored_messages,
    flushThreshold: config.checkpoint_flush_threshold,
    flushIntervalMs: config.checkpoint_flush_interval_ms,
    maxBufferedSessions: config.checkpoint_max_buffered_sessions,
  });
  return { id: "extra-checkpoint", tool: { extra_checkpoint: cp.tool }, ...cp.hooks };
};

export const judgeServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await getConfig();
  log.info(
    `judge: ${config.judge ? "enabled" : "disabled"}`,
  );
  const j = createJudgeTool({
    enabled: config.judge,
    model: config.judge_model,
    rubric: config.judge_rubric,
    judge_auto: config.judge_auto,
    ctx,
    // Phase-2 MEDIUM migration (E15): forward the YAML-configurable cap.
    // The factory clamps to 2-20, so an out-of-range YAML will not crash.
    maxCandidates: config.judge_max_candidates,
  });
  return { id: "extra-judge", tool: { extra_judge: j.tool }, ...j.hooks };
};

export const dreamServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await getConfig();
  log.info(
    `dream: ${config.dream ? "enabled" : "disabled"}`,
  );
  // Phase-1 HIGH migration (E7, E8, E9) + Phase-2 MEDIUM migration (E10):
  // forward YAML-configurable thresholds/caps/paths to the dream factory.
  // Defaults match the previous hardcoded values, so behavior is
  // unchanged when no YAML is present. The factory falls back to
  // `DEFAULT_ARCHIVE_PATH` when `archivePath` is empty.
  const d = createDreamTool({
    enabled: config.dream,
    threshold: config.dream_threshold,
    intervalHours: config.dream_interval_hours,
    ctx,
    dedupThreshold: config.dream_dedup_threshold,
    clusterThreshold: config.dream_cluster_threshold,
    maxEntries: config.dream_max_entries,
    archivePath: config.dream_archive_path,
  });
  return { id: "extra-dream", tool: { extra_dream: d.tool }, ...d.hooks };
};

async function getConfig(): Promise<ExtraConfig> {
  if (!_sharedConfig) _sharedConfig = await loadConfig<ExtraConfig>("extra", defaultConfig);
  return _sharedConfig;
}

// ---------------------------------------------------------------------------
// Merged server for standalone use (backward compat)
// ---------------------------------------------------------------------------

export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  const merged = mergeHooks([
    await checkpointServer(ctx),
    await judgeServer(ctx),
    await dreamServer(ctx),
  ]);
  return { ...merged, id };
};

export default { id, server };
