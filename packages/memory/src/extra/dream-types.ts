// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream types + constants
// Pure types/constants split from dream.ts (M-3 god-decomposition, Wave 1).
// No logic, no I/O — anything imported here is safe to use from any sibling
// dream-* module without creating a cycle.

import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_MEMORY_DB_PATH,
  HOOK_TOOL_EXECUTE_AFTER,
  SECONDS_PER_DAY,
  type RichPluginContext,
} from "@sffmc/utilities";

export type { RichPluginContext };

/** Jaccard similarity above which two memory entries are considered duplicates.
 *  Tuned for prose-style entries — 0.9 keeps near-verbatim repeats while
 *  avoiding false positives on "same topic, different angle".
 *
 *   HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_dedup_threshold`. The exported constant retains the
 *  prior value so any out-of-tree consumers (e.g. tests) still see 0.9. */
export const DREAM_DEDUP_THRESHOLD = 0.9;

/** Jaccard similarity above which a memory entry joins an existing cluster
 *  during summarization. Lower than the dedup threshold so a cluster can
 *  hold entries that share a topic without being near-duplicates.
 *
 *   HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_cluster_threshold`. */
export const DREAM_CLUSTER_THRESHOLD = 0.3;

/** Hard cap on entries processed in a single dream cycle. Prevents O(n^2)
 *  dedup/cluster loops from consuming unbounded CPU and memory when the DB
 *  grows large. Entries beyond this limit are skipped with a warning.
 *
 *   HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_max_entries`. */
export const MAX_DREAM_ENTRIES = 5000;

/** Inner-loop guard for the Jaccard dedup + cluster loops. Aliased to
 *  `MAX_DREAM_ENTRIES` so the cap has a discoverable name; it is enforced
 *  in `loadAndCacheMemories` via `Math.min(maxEntries, MAX_OVERFLOW)` so
 *  a misconfigured `maxEntries` cannot push the quadratic loops past the
 *  production budget. Default-config callers see no behavior change. */
export const MAX_OVERFLOW = MAX_DREAM_ENTRIES;

/** Max characters per entry used by the fallback `concatenateSummary` path
 *  and by `nameClusterViaLLM` (which feeds a topic-namer LLM that only needs
 *  a brief preview of each entry). 100 chars is enough to surface the topic
 *  without bloating the prompt.
 *
 *   LOW migration: this default is now configurable via
 *  `ExtraConfig.dream_snippet_length`. */
export const DREAM_SNIPPET_LENGTH = 100;

/** Max characters per entry used by `summarizeViaLLM` when building the
 *  summarization prompt. Larger than `DREAM_SNIPPET_LENGTH` because the
 *  summarizer needs more context to produce a 1-3 sentence summary.
 *
 *   LOW migration: this default is now configurable via
 *  `ExtraConfig.dream_llm_snippet_length`. */
export const DREAM_LLM_SNIPPET_LENGTH = 200;

/** Default path for the memory SQLite DB when `DreamConfig.storagePath` is
 *  not set. Resolved at module-load via `DEFAULT_MEMORY_DB_PATH()` from
 *  `@sffmc/utilities` so the path honours `SFFMC_DATA_DIR` / XDG overrides. */
export const DEFAULT_STORAGE_PATH = DEFAULT_MEMORY_DB_PATH();

/** Default JSONL path for archived memory entries. Overridable via
 *  `ExtraConfig.dream_archive_path` (forwarded to `DreamConfig.archivePath`). */
export const DEFAULT_ARCHIVE_PATH = resolve(
  homedir(),
  ".local/share/sffmc/extra/dream-archive.jsonl",
);

/** Age threshold (in days) for stale-removal — entries older than this are
 *  archived + deleted. Kept in sync with the `cron_lifecycle` /
 *  `dream_stale_days` config knobs (read at factory creation time). */
export const STALE_DAYS = 30;
export const SECONDS_PER_STALE_WINDOW = STALE_DAYS * SECONDS_PER_DAY;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamResult {
  scanned: number;
  deduped: number;
  archived: number;
  summarized: number;
  durationMs: number;
  errors: string[];
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  dry_run?: boolean;
}

export interface DreamConfig {
  enabled: boolean;
  threshold: number;
  intervalHours: number;
  /** DB path override (for testing). Defaults to ~/.local/share/sffmc/memory/index.sqlite */
  storagePath?: string;
  /** Plugin context for LLM-based summarization. When absent, falls back to concatenation. */
  ctx?: RichPluginContext;
  /** Model for LLM summarization. Defaults to "". */
  summaryModel?: string;
    // the v0.14.x hardcode audit (file not in git; see CHANGELOG.md v0.14.5)
  /** Jaccard dedup threshold. Defaults to `DREAM_DEDUP_THRESHOLD` (0.9). */
  dedupThreshold?: number;
  /** Jaccard cluster threshold. Defaults to `DREAM_CLUSTER_THRESHOLD` (0.3). */
  clusterThreshold?: number;
  /** Max entries processed per dream cycle. Defaults to `MAX_DREAM_ENTRIES` (5000). */
  maxEntries?: number;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §2.4
  /** JSONL path for archived memory entries. When empty, the
   *  default `DEFAULT_ARCHIVE_PATH` (`~/.local/share/sffmc/extra/dream-archive.jsonl`)
   *  is used. Set this to relocate the archive (e.g. on a different volume).
   *  Changing it mid-session after dream has already archived entries will
   *  split the archive across two files — set it before the  dream run. */
  archivePath?: string;
    // the v0.14.x hardcode migration plan (file not in git; see CHANGELOG.md v0.14.5) §3.3
  /** Max characters per entry in the concatenated summary (also used
   *  by `nameClusterViaLLM` to build the topic-naming prompt). Defaults to
   *  `DREAM_SNIPPET_LENGTH` (100). Recommended range: 20 ≤ x ≤ 1000. */
  snippetLength?: number;
  /** Max characters per entry in the LLM summarization prompt
   *  (`summarizeViaLLM`). Defaults to `DREAM_LLM_SNIPPET_LENGTH` (200).
   *  Recommended range: 50 ≤ x ≤ 4000. */
  llmSnippetLength?: number;
}

export interface DreamTool {
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string }>;
  };
  execute: (params?: { dry_run?: boolean }) => Promise<DreamResult>;
}

export interface DreamHooks {
  [HOOK_TOOL_EXECUTE_AFTER]?: (toolCtx: unknown, result: unknown) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface MemoryRow {
  id: number;
  source_path: string;
  section: string | null;
  content: string;
  importance_score: number;
  last_accessed: number | null;
  created_at: number;
}