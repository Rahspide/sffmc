// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream clustering primitives
// Greedy Jaccard clustering + cluster processing extracted from
// dream.ts (M-3 Wave 1). Pure cluster math + DB insert; no LLM I/O
// (that lives in dream-llm.ts).

import { Database } from "bun:sqlite";
import type { RichPluginContext } from "@sffmc/utilities";
import { jaccardSets } from "./dream-dedup.ts";
import { concatenateSummary } from "./dream-db.ts";
import {
  tryLLMClusterNaming,
  tryLLMClusterSummary,
} from "./dream-llm.ts";
import { type DreamResult, type MemoryRow } from "./dream-types.ts";

// ---------------------------------------------------------------------------
// Phase 5: greedy clustering
// ---------------------------------------------------------------------------

/** Phase 5: greedy clustering. For each unassigned row, start a cluster
 *  and expand it by adding any other row that has Jaccard > threshold
 *  with ANY cluster member. Expansion is capped at `maxIters` iterations
 *  to bound worst-case O(n³). Returns the full cluster list (singletons
 *  included — phase 6 filters by length). Pure. */
export function clusterSimilarRows(
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
      changed = expandClusterOnce(cluster, rows, clusterThreshold, tokenCache, assigned);
    }
    clusters.push(cluster);
  }
  return clusters;
}

/** Phase 5 helper: one expansion pass — for every unassigned `other`
 *  row whose Jaccard with ANY member of `cluster` exceeds the threshold,
 *  push it into the cluster and mark it assigned. Mutates `cluster` and
 *  `assigned` in place; returns `true` if anything was added (the
 *  orchestrator's `maxIters` loop relies on this signal to stop). The
 *  inner break on first match per `other` row keeps the algorithm
 *  O(n) per pass. Pure — no DB, no allocation beyond the cluster pushes. */
function expandClusterOnce(
  cluster: MemoryRow[],
  rows: MemoryRow[],
  clusterThreshold: number,
  tokenCache: Map<number, Set<string>>,
  assigned: Set<number>,
): boolean {
  let changed = false;
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
  return changed;
}

// ---------------------------------------------------------------------------
// Phase 6: process clusters
// ---------------------------------------------------------------------------

/** Phase 6 driver: iterate clusters, summarize + insert those with 5+ entries.
 *  Mutates `errors` (pushes LLM-failure messages) and the DB (inserts summary
 *  rows, deletes source rows when not dry-run). Returns the total summarized
 *  count. */
export async function processDreamClusters(opts: {
  clusters: MemoryRow[][];
  db: Database;
  dryRun: boolean;
  ctx: RichPluginContext | undefined;
  summaryModel: string | undefined;
  snippetLength: number;
  llmSnippetLength: number;
  errors: string[];
}): Promise<number> {
  const { clusters, ...rest } = opts;
  let summarized = 0;
  for (const cluster of clusters) {
    if (cluster.length < 5) continue;
    summarized += await processSingleCluster({ cluster, ...rest });
  }
  return summarized;
}

/** Phase 6 helper: summarize + insert ONE large cluster. Returns the
 *  cluster size so the orchestrator can add it to the running total.
 *  Always returns `cluster.length` (the cluster filter happened in the
 *  caller; this just processes one cluster at a time). */
async function processSingleCluster(opts: {
  cluster: MemoryRow[];
  db: Database;
  dryRun: boolean;
  ctx: RichPluginContext | undefined;
  summaryModel: string | undefined;
  snippetLength: number;
  llmSnippetLength: number;
  errors: string[];
}): Promise<number> {
  const {
    cluster,
    db,
    dryRun,
    ctx,
    summaryModel,
    snippetLength,
    llmSnippetLength,
    errors,
  } = opts;
  // The cluster `name` was already folded into `content`'s
  // 'Cluster: <name>\n\n' prefix inside summarizeClusterContent;
  // persisting it separately would be dead state.
  const { content } = await summarizeClusterContent({
    cluster,
    ctx,
    summaryModel,
    snippetLength,
    llmSnippetLength,
    errors,
  });
  insertClusterSummary(db, cluster, content, dryRun);
  return cluster.length;
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

  // No LLM available: use the concatenation fallback. The "Cluster:"
  // prefix is intentionally omitted in this path because there's no
  // LLM-generated cluster name to embed.
  if (!ctx) {
    return {
      name: "untitled cluster",
      content: concatenateSummary(cluster, snippetLength),
    };
  }

  const clusterName = await tryLLMClusterNaming(
    cluster,
    ctx,
    summaryModel,
    snippetLength,
    errors,
  );
  const summaryContent = await tryLLMClusterSummary(
    cluster,
    ctx,
    summaryModel,
    llmSnippetLength,
    snippetLength,
    errors,
  );

  return {
    name: clusterName,
    content: `Cluster: ${clusterName}\n\n${summaryContent}`,
  };
}

/** Phase 6 helper: insert a single cluster summary row (and delete the
 *  source rows) — or, in dry-run mode, do nothing (the caller still
 *  counts the cluster in `summarized` so the operator sees the simulated
 *  outcome). The new row's importance_score is the max of the cluster.
 *  Note: `name` (the LLM-generated cluster topic) is intentionally NOT
 *  persisted — the clusterName was already folded into `finalContent`'s
 *  `Cluster: <name>\n\n` prefix by `summarizeClusterContent`. */
function insertClusterSummary(
  db: Database,
  cluster: MemoryRow[],
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
export function makeDreamResult(state: {
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