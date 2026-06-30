// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream
// Real background memory-cleaning service. Multi-trigger (count threshold,
// cron, manual tool), Jaccard dedup, stale removal >30d, cluster summarization.

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import {
  createLogger,
  DEFAULT_MEMORY_DB_PATH,
  HOOK_TOOL_EXECUTE_AFTER,
  NoLLMClientError,
  redactSecrets,
  SECONDS_PER_DAY,
  unixNow,
} from "@sffmc/shared";
export type { RichPluginContext } from "@sffmc/shared";

/** Jaccard similarity above which two memory entries are considered duplicates.
 *  Tuned for prose-style entries — 0.9 keeps near-verbatim repeats while
 *  avoiding false positives on "same topic, different angle".
 *
 *  Initial release HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_dedup_threshold`. The exported constant retains the
 *  prior value so any out-of-tree consumers (e.g. tests) still see 0.9. */
export const DREAM_DEDUP_THRESHOLD = 0.9;

/** Jaccard similarity above which a memory entry joins an existing cluster
 *  during summarization. Lower than the dedup threshold so a cluster can
 *  hold entries that share a topic without being near-duplicates.
 *
 *  Initial release HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_cluster_threshold`. */
export const DREAM_CLUSTER_THRESHOLD = 0.3;

/** Hard cap on entries processed in a single dream cycle. Prevents O(n^2)
 *  dedup/cluster loops from consuming unbounded CPU and memory when the DB
 *  grows large. Entries beyond this limit are skipped with a warning.
 *
 *  Initial release HIGH migration: this default is now configurable via
 *  `ExtraConfig.dream_max_entries`. */
export const MAX_DREAM_ENTRIES = 5000;

/** Max characters per entry used by the fallback `concatenateSummary` path
 *  and by `nameClusterViaLLM` (which feeds a topic-namer LLM that only needs
 *  a brief preview of each entry). 100 chars is enough to surface the topic
 *  without bloating the prompt.
 *
 *   release LOW migration: this default is now configurable via
 *  `ExtraConfig.dream_snippet_length`. */
export const DREAM_SNIPPET_LENGTH = 100;

/** Max characters per entry used by `summarizeViaLLM` when building the
 *  summarization prompt. Larger than `DREAM_SNIPPET_LENGTH` because the
 *  summarizer needs more context to produce a 1-3 sentence summary.
 *
 *   release LOW migration: this default is now configurable via
 *  `ExtraConfig.dream_llm_snippet_length`. */
export const DREAM_LLM_SNIPPET_LENGTH = 200;

const log = createLogger("extra-dream");

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
    // .slim/deepwork/hardcode-audit-2026-06.md
  /** Jaccard dedup threshold. Defaults to `DREAM_DEDUP_THRESHOLD` (0.9). */
  dedupThreshold?: number;
  /** Jaccard cluster threshold. Defaults to `DREAM_CLUSTER_THRESHOLD` (0.3). */
  clusterThreshold?: number;
  /** Max entries processed per dream cycle. Defaults to `MAX_DREAM_ENTRIES` (5000). */
  maxEntries?: number;
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §2.4
  /** JSONL path for archived memory entries. When empty, the
   *  default `DEFAULT_ARCHIVE_PATH` (`~/.local/share/sffmc/extra/dream-archive.jsonl`)
   *  is used. Set this to relocate the archive (e.g. on a different volume).
   *  Changing it mid-session after dream has already archived entries will
   *  split the archive across two files — set it before the  dream run. */
  archivePath?: string;
    // .slim/deepwork/phase-2-3-hardcode-migration-plan.md §3.3
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
// Jaccard similarity
// ---------------------------------------------------------------------------

function tokenize(s: string): Set<string> {
  const cleaned = s.toLowerCase().replace(/[^\w\s]/g, " ");
  const tokens = cleaned.split(/\s+/).filter((t) => t.length > 0);
  return new Set(tokens);
}

function jaccard(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** Jaccard similarity between pre-tokenized sets. Avoids re-tokenizing on
 *  every call — used by the hot dedup + cluster loops in runDream via
 *  the tokenCache. Returns 0 if either set is empty (matches jaccard()). */
function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  if (a.size === 0 || b.size === 0) return 0;
  // Iterate the smaller set to minimize .has() calls
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const t of small) if (large.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_PATH = DEFAULT_MEMORY_DB_PATH();
/** Default JSONL path for archived memory entries. Overridable via
 *  `ExtraConfig.dream_archive_path` (forwarded to `DreamConfig.archivePath`). */
export const DEFAULT_ARCHIVE_PATH = resolve(
  homedir(),
  ".local/share/sffmc/extra/dream-archive.jsonl",
);
const STALE_DAYS = 30;
const SECONDS_PER_STALE_WINDOW = STALE_DAYS * SECONDS_PER_DAY;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openDB(dbPath: string): Database {
  // Ensure the directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  return db;
}

function ensureArchiveDir(archivePath: string): void {
  const dir = dirname(archivePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function archiveEntry(entry: MemoryRow, archivePath: string): void {
  ensureArchiveDir(archivePath);
  // Redact content before writing to the dream archive. The archive
  // is on-disk JSONL; if a memory row embedded a raw credential, the
  // archive would persist it forever. `redactSecrets` returns the redacted
  // text plus categories + count for forensic visibility.
  const redaction = redactSecrets(entry.content);
  const record = {
    id: entry.id,
    source_path: entry.source_path,
    section: entry.section,
    content: redaction.redacted,
    redaction_count: redaction.count,
    redaction_categories: redaction.categories,
    importance_score: entry.importance_score,
    last_accessed: entry.last_accessed,
    created_at: entry.created_at,
    archived_at_ms: Date.now(),
    archived_at_iso: new Date().toISOString(),
  };
  appendFileSync(archivePath, JSON.stringify(record) + "\n");
}

/** Fallback summarization: concatenate  `snippetLength` chars of each entry.
 *   release LOW migration: `snippetLength` is now configurable via
 *  `DreamConfig.snippetLength`; defaults to `DREAM_SNIPPET_LENGTH` (100). */
function concatenateSummary(
  entries: MemoryRow[],
  snippetLength: number = DREAM_SNIPPET_LENGTH,
): string {
  const snippets = entries.map((e) => {
    const text = e.content.substring(0, snippetLength);
    const ellipsis = e.content.length > snippetLength ? "…" : "";
    return `[${e.source_path}] ${text}${ellipsis}`;
  });
  return `DREAM-SUMMARY (${entries.length} entries merged):\n${snippets.join("\n")}`;
}

/** LLM-based cluster naming: generates a 3-5 word topic phrase for a cluster.
 *   release LOW migration: the per-entry preview length is now
 *  configurable via `snippetLength` (defaults to `DREAM_SNIPPET_LENGTH` = 100). */
export async function nameClusterViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
  snippetLength: number = DREAM_SNIPPET_LENGTH,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new NoLLMClientError();
  }
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, snippetLength)}`,
  );
  const system =
    "You are a topic-namer. Given a cluster of related memory entries, produce a 3-5 word phrase that names the topic. Output ONLY the phrase, nothing else.";
  const user = `Name the topic of these ${cluster.length} related memory entries:\n\n${entries.join("\n\n")}`;
  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.2,
  });
  const text = response.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n")
    .trim();
  return text || "untitled cluster";
}

/** LLM-based summarization: sends cluster entries to the model for a concise summary.
 *   release LOW migration: the per-entry length is now configurable via
 *  `llmSnippetLength` (defaults to `DREAM_LLM_SNIPPET_LENGTH` = 200). */
async function summarizeViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
  llmSnippetLength: number = DREAM_LLM_SNIPPET_LENGTH,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new NoLLMClientError();
  }
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, llmSnippetLength)}`,
  );
  const system =
    "You are a memory summarizer. Produce a concise 1-3 sentence summary of the following related memory entries, capturing the single most important insight.";
  const user = `Summarize these ${cluster.length} related memory entries:\n\n${entries.join("\n\n")}`;
  const response = await session.message({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    model,
    temperature: 0.3,
  });
  const text = response.content
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && typeof p.text === "string",
    )
    .map((p) => p.text)
    .join("\n");
  return text.trim() || concatenateSummary(cluster);
}

// ---------------------------------------------------------------------------
// Dream engine
// ---------------------------------------------------------------------------

/**
 * Run the full dream cycle: scan → dedup → stale removal → summarization.
 * Returns DreamResult with counts and any errors.
 *
 * Initial release HIGH migration: `dedupThreshold`, `clusterThreshold`,
 * and `maxEntries` are now configurable (via DreamConfig). The exported
 * module-level constants (`DREAM_DEDUP_THRESHOLD`, `DREAM_CLUSTER_THRESHOLD`,
 * `MAX_DREAM_ENTRIES`) remain as the defaults — behavior is unchanged when
 * the caller omits the new fields.
 *
 *  release MEDIUM migration: `archivePath` is now configurable. The
 * default `DEFAULT_ARCHIVE_PATH` (`~/.local/share/sffmc/extra/dream-archive.jsonl`)
 * is used when the caller omits the field.
 *
 *  release LOW migration: `snippetLength` (default
 * `DREAM_SNIPPET_LENGTH` = 100, used by `concatenateSummary` and
 * `nameClusterViaLLM`) and `llmSnippetLength` (default
 * `DREAM_LLM_SNIPPET_LENGTH` = 200, used by `summarizeViaLLM`) are now
 * configurable. Behavior is unchanged when the caller omits the new fields.
 */
async function runDream(
  db: Database,
  dryRun: boolean,
  ctx?: RichPluginContext,
  summaryModel?: string,
  dedupThreshold: number = DREAM_DEDUP_THRESHOLD,
  clusterThreshold: number = DREAM_CLUSTER_THRESHOLD,
  maxEntries: number = MAX_DREAM_ENTRIES,
  archivePath: string = DEFAULT_ARCHIVE_PATH,
  snippetLength: number = DREAM_SNIPPET_LENGTH,
  llmSnippetLength: number = DREAM_LLM_SNIPPET_LENGTH,
): Promise<DreamResult> {
  const errors: string[] = [];
  const start = Date.now();
  let scanned = 0;
  let deduped = 0;
  let archived = 0;
  let summarized = 0;

  try {
    // ── Phase 1: load + pre-tokenize (with O(n²) cap guard) ──────────
    const loaded = loadAndCacheMemories(db, maxEntries);
    if (loaded.kind === "skip") {
      log.warn(
        `dream: ${loaded.scanned} entries exceed cap of ${maxEntries} — skipping dedup/cluster to avoid O(n^2) blowup`,
      );
      return makeDreamResult({
        scanned: loaded.scanned,
        deduped: 0,
        archived: 0,
        summarized: 0,
        durationMs: Date.now() - start,
        errors: [loaded.skipMsg],
        dryRun,
        ok: true,
      });
    }
    scanned = loaded.rows.length;
    const { rows, tokenCache } = loaded;

    // ── Phase 2: dedup (Jaccard > threshold, keep newer) ─────────────
    const dedupSet = dedupRows(rows, dedupThreshold, tokenCache);
    if (dedupSet.size > 0 && !dryRun) {
      for (const id of dedupSet) {
        db.run("DELETE FROM memory_entries WHERE id = ?", [id]);
      }
    }
    deduped = dedupSet.size;

    // ── Phase 3: stale removal (>30d, archive + delete) ──────────────
    const staleThresholdSec = unixNow() - SECONDS_PER_STALE_WINDOW;
    const allStale = findStaleEntries(db, staleThresholdSec);
    for (const entry of allStale) {
      if (!dryRun) {
        archiveEntry(entry, archivePath);
        db.run("DELETE FROM memory_entries WHERE id = ?", [entry.id]);
      }
    }
    archived = allStale.length;

    // ── Phase 4: re-read post-dedup+stale + rebuild token cache ──────
    const remainingRows = loadRemainingRows(db, dryRun, rows, dedupSet, allStale);
    const remainingTokenCache = rebuildTokenCache(remainingRows, tokenCache);

    // ── Phase 5: greedy clustering (5-iteration cap) ─────────────────
    const clusters = clusterSimilarRows(
      remainingRows,
      clusterThreshold,
      remainingTokenCache,
      5,
    );

    // ── Phase 6: process clusters of 5+ (LLM name + summary + insert)
    summarized = await processDreamClusters({
      clusters,
      db,
      dryRun,
      ctx,
      summaryModel,
      snippetLength,
      llmSnippetLength,
      errors,
    });

    return makeDreamResult({
      scanned,
      deduped,
      archived,
      summarized,
      durationMs: Date.now() - start,
      errors,
      dryRun,
      ok: true,
    });
  } catch (err) {
    errors.push(String(err));
    return makeDreamResult({
      scanned,
      deduped,
      archived,
      summarized,
      durationMs: Date.now() - start,
      errors,
      dryRun,
      ok: errors.length === 0,
    });
  }
}

// ---------------------------------------------------------------------------
// Dream engine — sub-helpers (M-3 split, all non-exported)
// ---------------------------------------------------------------------------

/** Phase 1: read all memory rows and pre-tokenize. The cap guard returns
 *  a `skip` result when `scanned > maxEntries` so the orchestrator can
 *  short-circuit before the O(n²) dedup/cluster loops. The token cache is
 *  populated once (O(n)) so dedup + cluster comparisons are O(1) each. */
function loadAndCacheMemories(
  db: Database,
  maxEntries: number,
):
  | { kind: "skip"; scanned: number; skipMsg: string }
  | { kind: "ok"; rows: MemoryRow[]; tokenCache: Map<number, Set<string>> } {
  const rows = db
    .query("SELECT * FROM memory_entries ORDER BY created_at DESC")
    .all() as MemoryRow[];

  if (rows.length > maxEntries) {
    return {
      kind: "skip",
      scanned: rows.length,
      skipMsg: `Skipped: ${rows.length} entries exceed MAX_DREAM_ENTRIES (${maxEntries})`,
    };
  }

  // Pre-tokenize all rows once. The dedup + cluster loops would otherwise
  // call tokenize() on the same content O(n) times each — O(n²) total
  // regex + Set allocations. With tokenCache, tokenize runs O(n) times
  // and every comparison is O(1) (jaccardSets). v0.14.x: 3-5x speedup
  // observed on 1000+ entry workloads.
  const tokenCache = new Map<number, Set<string>>();
  for (const row of rows) {
    tokenCache.set(row.id, tokenize(row.content));
  }

  return { kind: "ok", rows, tokenCache };
}

/** Phase 2: Jaccard-similarity dedup. For every pair above
 *  `dedupThreshold`, mark the older one (by last_accessed or created_at,
 *  falling back to array order on ties) for deletion. Pure — does not
 *  touch the DB; the caller iterates the returned set to issue DELETEs. */
function dedupRows(
  rows: MemoryRow[],
  dedupThreshold: number,
  tokenCache: Map<number, Set<string>>,
): Set<number> {
  const dedupSet = new Set<number>();
  if (rows.length <= 1) return dedupSet;

  for (let i = 0; i < rows.length; i++) {
    if (dedupSet.has(rows[i].id)) continue;
    for (let j = i + 1; j < rows.length; j++) {
      if (dedupSet.has(rows[j].id)) continue;
      if (rows[i].id === rows[j].id) continue;
      const sim = jaccardSets(
        tokenCache.get(rows[i].id)!,
        tokenCache.get(rows[j].id)!,
      );
      if (sim > dedupThreshold) {
        // Keep newer (by last_accessed or created_at); delete older.
        // Timestamps are in s (SQLite strftime('%s','now')).
        const timeI = rows[i].last_accessed ?? rows[i].created_at;
        const timeJ = rows[j].last_accessed ?? rows[j].created_at;
        if (timeI >= timeJ) {
          dedupSet.add(rows[j].id);
        } else {
          dedupSet.add(rows[i].id);
          break; // rows[i] is the older duplicate; stop comparing it
        }
      }
    }
  }
  return dedupSet;
}

/** Phase 3: stale removal query. Two SELECTs — one for entries with
 *  `last_accessed < threshold` and one for entries where `last_accessed`
 *  IS NULL and `created_at < threshold`. Returns the concatenated list;
 *  the caller iterates to archive + delete. */
function findStaleEntries(db: Database, staleThresholdSec: number): MemoryRow[] {
  const staleAccessed = db
    .query(
      "SELECT * FROM memory_entries WHERE last_accessed IS NOT NULL AND last_accessed < ?",
    )
    .all(staleThresholdSec) as MemoryRow[];

  const staleNullAccessed = db
    .query(
      "SELECT * FROM memory_entries WHERE last_accessed IS NULL AND created_at < ?",
    )
    .all(staleThresholdSec) as MemoryRow[];

  return [...staleAccessed, ...staleNullAccessed];
}

/** Phase 4 helper: re-read the DB post-dedup+stale (or simulate the
 *  filtering in dry-run mode) and produce the post-state row set. The
 *  non-dry-run branch orders by `importance_score DESC` so the cluster
 *  loop iterates high-importance rows first. */
function loadRemainingRows(
  db: Database,
  dryRun: boolean,
  originalRows: MemoryRow[],
  dedupSet: Set<number>,
  allStale: MemoryRow[],
): MemoryRow[] {
  if (!dryRun) {
    return db
      .query("SELECT * FROM memory_entries ORDER BY importance_score DESC")
      .all() as MemoryRow[];
  }
  // Dry run: simulate what WOULD remain after dedup + stale removal
  const staleIds = new Set(allStale.map((e) => e.id));
  return originalRows.filter(
    (r) => !dedupSet.has(r.id) && !staleIds.has(r.id),
  );
}

/** Phase 4 helper: rebuild the token cache for the surviving rows. In
 *  dry-run, remainingRows is filtered from the original `rows` so the
 *  cached sets are valid as-is. In non-dry-run, the DB SELECT returns
 *  the surviving IDs — a subset of the original `rows` IDs (SQLite
 *  AUTOINCREMENT never recycles). The `?? tokenize(...)` fallback is
 *  a defensive guard for any future code path that re-inserts rows
 *  (e.g., a stale-removal recovery hook). */
function rebuildTokenCache(
  rows: MemoryRow[],
  sourceCache: Map<number, Set<string>>,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  for (const row of rows) {
    const cached = sourceCache.get(row.id);
    out.set(row.id, cached ?? tokenize(row.content));
  }
  return out;
}

/** Phase 5: greedy clustering. For each unassigned row, start a cluster
 *  and expand it by adding any other row that has Jaccard > threshold
 *  with ANY cluster member. Expansion is capped at `maxIters` iterations
 *  to bound worst-case O(n³). Returns the full cluster list (singletons
 *  included — phase 6 filters by length). Pure. */
function clusterSimilarRows(
  rows: MemoryRow[],
  clusterThreshold: number,
  tokenCache: Map<number, Set<string>>,
  maxIters: number,
): MemoryRow[][] {
  const clusters: MemoryRow[][] = [];
  const assigned = new Set<number>();

  for (const row of rows) {
    if (assigned.has(row.id)) continue;
    const cluster: MemoryRow[] = [row];
    assigned.add(row.id);

    let changed = true;
    for (let iter = 0; iter < maxIters && changed; iter++) {
      changed = false;
      for (const other of rows) {
        if (assigned.has(other.id)) continue;
        for (const member of cluster) {
          if (
            jaccardSets(
              tokenCache.get(member.id)!,
              tokenCache.get(other.id)!,
            ) > clusterThreshold
          ) {
            cluster.push(other);
            assigned.add(other.id);
            changed = true;
            break;
          }
        }
      }
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Phase 6 driver: iterate clusters, summarize + insert those with 5+ entries.
 *  Mutates `errors` (pushes LLM-failure messages) and the DB (inserts summary
 *  rows, deletes source rows when not dry-run). Returns the total summarized
 *  count. */
async function processDreamClusters(opts: {
  clusters: MemoryRow[][];
  db: Database;
  dryRun: boolean;
  ctx: RichPluginContext | undefined;
  summaryModel: string | undefined;
  snippetLength: number;
  llmSnippetLength: number;
  errors: string[];
}): Promise<number> {
  const {
    clusters,
    db,
    dryRun,
    ctx,
    summaryModel,
    snippetLength,
    llmSnippetLength,
    errors,
  } = opts;
  let summarized = 0;
  for (const cluster of clusters) {
    if (cluster.length < 5) continue;
    const { name, content } = await summarizeClusterContent({
      cluster,
      ctx,
      summaryModel,
      snippetLength,
      llmSnippetLength,
      errors,
    });
    insertClusterSummary(db, cluster, name, content, dryRun);
    summarized += cluster.length;
  }
  return summarized;
}

/** Phase 6 helper: name + summarize one cluster. When `ctx` is absent
 *  (or both LLM calls fail), falls back to concatenation. Returns the
 *  cluster name (defaults to `"untitled cluster"`) and the final content
 *  (with `"Cluster: <name>\n\n"` prefix when LLM was used). */
async function summarizeClusterContent(opts: {
  cluster: MemoryRow[];
  ctx: RichPluginContext | undefined;
  summaryModel: string | undefined;
  snippetLength: number;
  llmSnippetLength: number;
  errors: string[];
}): Promise<{ name: string; content: string }> {
  const { cluster, ctx, summaryModel, snippetLength, llmSnippetLength, errors } =
    opts;
  let clusterName = "untitled cluster";
  let summaryContent: string;

  if (ctx) {
    try {
      clusterName = await nameClusterViaLLM(
        cluster,
        ctx,
        summaryModel ?? "",
        snippetLength,
      );
    } catch (err) {
      errors.push(`cluster naming LLM failed: ${String(err)}`);
    }
    try {
      summaryContent = await summarizeViaLLM(
        cluster,
        ctx,
        summaryModel ?? "",
        llmSnippetLength,
      );
    } catch (err) {
      errors.push(
        `summarization LLM failed for cluster of ${cluster.length}: ${String(err)}`,
      );
      summaryContent = concatenateSummary(cluster, snippetLength);
    }
  } else {
    summaryContent = concatenateSummary(cluster, snippetLength);
  }

  const finalContent = ctx
    ? `Cluster: ${clusterName}\n\n${summaryContent}`
    : summaryContent;
  return { name: clusterName, content: finalContent };
}

/** Phase 6 helper: insert a single cluster summary row (and delete the
 *  source rows) — or, in dry-run mode, do nothing (the caller still
 *  counts the cluster in `summarized` so the operator sees the simulated
 *  outcome). The new row's importance_score is the max of the cluster. */
function insertClusterSummary(
  db: Database,
  cluster: MemoryRow[],
  _name: string,
  finalContent: string,
  dryRun: boolean,
): void {
  if (dryRun) return;
  const maxImportance = Math.max(...cluster.map((e) => e.importance_score));
  db.run(
    "INSERT INTO memory_entries (source_path, section, content, importance_score) VALUES (?, ?, ?, ?)",
    ["dream-summary", null, finalContent, maxImportance],
  );
  for (const entry of cluster) {
    db.run("DELETE FROM memory_entries WHERE id = ?", [entry.id]);
  }
}

/** Build a DreamResult from the orchestrator's counters. The `ok` flag
 *  is computed by the caller (success path → `ok: true`; error path
 *  → `ok: errors.length === 0`). */
function makeDreamResult(state: {
  scanned: number;
  deduped: number;
  archived: number;
  summarized: number;
  durationMs: number;
  errors: string[];
  dryRun: boolean;
  ok: boolean;
}): DreamResult {
  return {
    scanned: state.scanned,
    deduped: state.deduped,
    archived: state.archived,
    summarized: state.summarized,
    durationMs: state.durationMs,
    errors: state.errors,
    ok: state.ok,
    dry_run: state.dryRun,
  };
}

// ---------------------------------------------------------------------------
// Concurrency lock & cron state — per-instance (DLC: no shared state between plugins)
// ---------------------------------------------------------------------------

interface DreamInstanceState {
  dreamLock: Promise<DreamResult> | null;
  cronTimer: ReturnType<typeof setInterval> | null;
}

/** Reference to the most recently created factory instance's state.
 *  Module-level wrapper functions delegate to this for backward compatibility with tests.
 *
 *  Dream module state (Manriel audit, v0.14.x): the only module-level mutable
 *  state in this file is `_activeDreamState` (declared below). It is a singleton
 *  reference to the most-recently-created `DreamInstanceState`. The
 *  race risk is bounded:
 *
 *  - Concurrent `createDreamTool()` calls: each factory synchronously
 *    assigns `_activeDreamState = state`. The last writer wins, so
 *    `clearCronTimer()` / `isDreamLocked()` may target the wrong
 *    instance when two factories are alive simultaneously. This is
 *    acceptable in practice because the test harness and the host
 *    process each maintain exactly one active dream factory. The
 *    singleton is NOT intended to multiplex multiple instances.
 *
 *  - Concurrent `tool.execute()` calls within a single factory: safe.
 *    The per-instance `state.dreamLock` Promise serializes them (see
 *    `executeDream()` in `createDreamTool`).
 *
  *  - The constant declarations above (`DREAM_DEDUP_THRESHOLD`,
  *    `DREAM_CLUSTER_THRESHOLD`, `MAX_DREAM_ENTRIES`,
  *    `DEFAULT_STORAGE_PATH`, `DEFAULT_ARCHIVE_PATH`, `STALE_DAYS`,
  *    `SECONDS_PER_STALE_WINDOW`) are immutable.
 *
 *  If a future use case requires multiple dream factories, replace
 *  `_activeDreamState` with a `Map<factoryId, DreamInstanceState>`
 *  and update `clearCronTimer` / `isDreamLocked` to take a factory
 *  handle. For now, the singleton is the documented contract.
 */
let _activeDreamState: DreamInstanceState | null = null;

/** Clear a previously-set cron timer (useful for tests). */
export function clearCronTimer(): void {
  if (_activeDreamState?.cronTimer != null) {
    clearInterval(_activeDreamState.cronTimer);
    _activeDreamState.cronTimer = null;
  }
}

/** Expose the dream lock so tests can inspect concurrency state. */
export function isDreamLocked(): boolean {
  return (_activeDreamState?.dreamLock ?? null) !== null;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDreamTool(config: DreamConfig): {
  tool: DreamTool;
  hooks: DreamHooks;
} {
  const dbPath = config.storagePath ?? DEFAULT_STORAGE_PATH;
  let db: Database | null = null;

    // thresholds/cap up front so they are stable across the lifetime of
  // this factory instance. Defaults preserve prior behavior.
  const dedupThreshold = config.dedupThreshold ?? DREAM_DEDUP_THRESHOLD;
  const clusterThreshold = config.clusterThreshold ?? DREAM_CLUSTER_THRESHOLD;
  const maxEntries = config.maxEntries ?? MAX_DREAM_ENTRIES;
    // Empty string / undefined falls back to the homedir default. This
  // replaces the previous module-level `ARCHIVE_PATH` constant.
  const archivePath = config.archivePath || DEFAULT_ARCHIVE_PATH;
    // they are stable across the lifetime of this factory instance. Defaults
  // preserve prior behavior.
  const snippetLength = config.snippetLength ?? DREAM_SNIPPET_LENGTH;
  const llmSnippetLength = config.llmSnippetLength ?? DREAM_LLM_SNIPPET_LENGTH;

  // Per-instance state (DLC: no shared state between plugins)
  const state: DreamInstanceState = {
    dreamLock: null,
    cronTimer: null,
  };
  _activeDreamState = state;

  function getDB(): Database {
    if (!db) {
      db = openDB(dbPath);
    }
    return db;
  }

  /**
   * Core dream executor. Wraps runDream with the concurrency lock and
   * the disabled check.
   */
  async function executeDream(dryRun = false): Promise<DreamResult> {
    if (!config.enabled) {
      return {
        scanned: 0,
        deduped: 0,
        archived: 0,
        summarized: 0,
        durationMs: 0,
        errors: [],
        ok: true,
        skipped: true,
        reason: "feature disabled",
      };
    }

    // Concurrency lock: only one dream run at a time
    if (state.dreamLock) {
      return {
        scanned: 0,
        deduped: 0,
        archived: 0,
        summarized: 0,
        durationMs: 0,
        errors: [],
        ok: true,
        skipped: true,
        reason: "dream already in progress",
      };
    }

    const database = getDB();
    state.dreamLock = runDream(
      database,
      dryRun,
      config.ctx,
      config.summaryModel,
      dedupThreshold,
      clusterThreshold,
      maxEntries,
      archivePath,
      snippetLength,
      llmSnippetLength,
    );
    try {
      const result = await state.dreamLock;
      return result;
    } finally {
      state.dreamLock = null;
    }
  }

  // ── Tool definition ─────────────────────────────────────────────
  const tool: DreamTool = {
    description: `Dream — background memory cleaning.
Triggers: count>${config.threshold} OR ${config.intervalHours}h cron OR manual.
Actions: dedup (Jaccard > ${DREAM_DEDUP_THRESHOLD}), stale removal (>${STALE_DAYS}d), cluster summarization (5+ similar).`,

    parameters: {
      type: "object",
      properties: {
        dry_run: { type: "boolean" },
      },
    },

    execute: async (params?: { dry_run?: boolean }) => {
      return executeDream(params?.dry_run ?? false);
    },
  };

  // ── Hooks ───────────────────────────────────────────────────────
  const hooks: DreamHooks = {
    [HOOK_TOOL_EXECUTE_AFTER]: async (_toolCtx: unknown, _result: unknown) => {
      if (!config.enabled) return;
      try {
        const database = getDB();
        const row = database
          .query("SELECT COUNT(*) as cnt FROM memory_entries")
          .get() as { cnt: number } | null;
        const count = row?.cnt ?? 0;
        if (count > config.threshold) {
          log.info(
            `dream: auto-triggered (count=${count} > threshold=${config.threshold})`,
          );
          // Fire-and-forget so the hook doesn't block the tool pipeline
          executeDream(false).catch((err) => {
            log.error("dream: auto-trigger error:", err);
          });
        }
      } catch (err) {
        log.error("dream: count check error:", err);
      }
    },
  };

  // ── Cron schedule ───────────────────────────────────────────────
  // Note: no OpenCode shutdown hook exists, so the timer is intentionally
  // leaked. On process exit, setInterval is cleaned up by the runtime.
  // The unref() call (when available) allows the process to exit without
  // waiting for the next tick.
  if (config.enabled && config.intervalHours > 0) {
    // Clear any previous timer (tests may call createDreamTool multiple times)
    if (state.cronTimer !== null) {
      clearInterval(state.cronTimer);
    }
    const intervalMs = config.intervalHours * 3600 * 1000;
    state.cronTimer = setInterval(() => {
      log.info(
        `dream: cron triggered (${config.intervalHours}h interval)`,
      );
      executeDream(false).catch((err) => {
        log.error("dream: cron error:", err);
      });
    }, intervalMs);
    if (typeof state.cronTimer.unref === "function") {
      state.cronTimer.unref();
    }
  }

  return { tool, hooks };
}
