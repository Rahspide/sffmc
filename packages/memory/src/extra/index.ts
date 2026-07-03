// SPDX-License-Identifier: MIT
// @sffmc/extra — see ../../LICENSE
//
// Houses three opt-in sub-features: checkpoint, judge, dream.
// Each can be composed individually by @sffmc/memory MSP, or all
// three can be loaded together via this package's default export
// (standalone usage).
//
//  release (v0.9.0): factory pattern replaced with named server
// exports so the memory MSP can compose them via runtime hook().

import { loadConfig, mergeHooks, type PluginContext, createLogger, type PluginServer } from "@sffmc/utilities";
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
    /** max checkpoint file size — max checkpoint file size in bytes (default 10 MiB). */
  checkpoint_max_file_size: number;
  /** max restored messages — max messages restored from a single checkpoint (default 50). */
  checkpoint_max_restored_messages: number;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §2.3
  /** buffer flush threshold — buffer flush threshold (tool calls buffered before disk flush). */
  checkpoint_flush_threshold: number;
  /** periodic flush interval — periodic flush interval in ms. */
  checkpoint_flush_interval_ms: number;
  /** max in-memory session buffers — max in-memory session buffers (LRU eviction when exceeded). */
  checkpoint_max_buffered_sessions: number;
  /** Jaccard dedup threshold — Jaccard dedup threshold for dream (default 0.9). */
  dream_dedup_threshold: number;
  /** Jaccard cluster threshold — Jaccard cluster threshold for dream (default 0.3). */
  dream_cluster_threshold: number;
  /** dream max entries — max entries processed per dream cycle (default 5000). */
  dream_max_entries: number;
  /** dream archive path — JSONL path for archived dream entries. Empty string means
   *  "use the homedir default" (`~/.local/share/sffmc/extra/dream-archive.jsonl`). */
  dream_archive_path: string;
  /** dream snippet length — max characters per entry in the concatenated dream summary
   *  (also used by `nameClusterViaLLM`). Recommended range: 20 ≤ x ≤ 1000. */
  dream_snippet_length: number;
  /** dream LLM snippet length — max characters per entry in the LLM summarization prompt.
   *  Recommended range: 50 ≤ x ≤ 4000. */
  dream_llm_snippet_length: number;
  /** judge prompt — max candidates per judge call. Validated to the 2-20 range. */
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
  checkpoint_max_file_size: 10 * 1024 * 1024, // max checkpoint file size: 10 MiB
  checkpoint_max_restored_messages: 50,        // max restored messages
  checkpoint_flush_threshold: 50,              // buffer flush threshold
  checkpoint_flush_interval_ms: 5_000,         // periodic flush interval
  checkpoint_max_buffered_sessions: 50,        // max in-memory session buffers
  dream_dedup_threshold: 0.9,                  // Jaccard dedup threshold
  dream_cluster_threshold: 0.3,                // Jaccard cluster threshold
  dream_max_entries: 5000,                     // dream max entries
  dream_archive_path: "",                      // dream archive path: empty → DEFAULT_ARCHIVE_PATH
  dream_snippet_length: 100,                   // dream snippet length
  dream_llm_snippet_length: 200,               // dream LLM snippet length
  judge_max_candidates: 8,                     // judge prompt
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

// Cache the config once so the three module servers don't each re-parse
// the same file. They share the same ExtraConfig and call factories with
// overlapping fields — a single read is enough.
let _sharedConfig: ExtraConfig | undefined;

export const checkpointServer = async (ctx: PluginContext): Promise<PluginServer> => {
  const config = await getConfig();
  const resolvedCheckpointDir = config.checkpoint_dir || DEFAULT_CHECKPOINT_DIR;
  log.info(
    `checkpoint: ${config.checkpoint ? "enabled" : "disabled"}`,
  );
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
    // +  release migration (dream snippet length, dream LLM snippet length): forward YAML-configurable
  // thresholds/caps/paths/sizes to the dream factory. Defaults match the
  // previous hardcoded values, so behavior is unchanged when no YAML is
  // present. The factory falls back to `DEFAULT_ARCHIVE_PATH` when
  // `archivePath` is empty, and to the documented constants
  // (`DREAM_SNIPPET_LENGTH` = 100, `DREAM_LLM_SNIPPET_LENGTH` = 200) when
  // the snippet-length fields are omitted.
  const d = createDreamTool({
    enabled: config.dream,
    threshold: config.dream_threshold,
    intervalHours: config.dream_interval_hours,
    ctx,
    dedupThreshold: config.dream_dedup_threshold,
    clusterThreshold: config.dream_cluster_threshold,
    maxEntries: config.dream_max_entries,
    archivePath: config.dream_archive_path,
    snippetLength: config.dream_snippet_length,
    llmSnippetLength: config.dream_llm_snippet_length,
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
