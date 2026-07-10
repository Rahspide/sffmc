// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream dedup primitives
// Jaccard-similarity dedup + token cache + stale-row finder extracted
// from dream.ts (M-3 Wave 1). Pure data shape; no LLM, no orchestration.

import { Database } from "bun:sqlite";
import { createLogger } from "@sffmc/utilities";
import { MAX_OVERFLOW, type MemoryRow } from "./dream-types.ts";

const log = createLogger("extra-dream");

// ---------------------------------------------------------------------------
// Jaccard similarity primitives
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
 *  the tokenCache. Returns 0 if either set is empty (matches jaccard()).
 *  Exported because `dream-clustering.ts` reuses it for the cluster
 *  expansion loop. */
export function jaccardSets(a: Set<string>, b: Set<string>): number {
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
// Phase 1: load + pre-tokenize (with O(n²) cap guard)
// ---------------------------------------------------------------------------

/** Phase 1: read all memory rows and pre-tokenize. The cap guard returns
 *  a `skip` result when `scanned > effectiveCap` so the orchestrator can
 *  short-circuit before the O(n²) dedup/cluster loops. The token cache is
 *  populated once (O(n)) so dedup + cluster comparisons are O(1) each.
 *
 *  `effectiveCap` is `Math.min(maxEntries, MAX_OVERFLOW)` — defense-in-depth
 *  against a misconfigured `maxEntries` (e.g., a future caller that passes
 *  a value larger than the production O(n²) budget). Default-config callers
 *  see no behavior change; the clamp only kicks in when config would
 *  otherwise bypass the 5000-entry cap. */
export function loadAndCacheMemories(
  db: Database,
  maxEntries: number,
):
  | { kind: "skip"; scanned: number; skipMsg: string }
  | { kind: "ok"; rows: MemoryRow[]; tokenCache: Map<number, Set<string>> } {
  const rows = loadMemoryRows(db);

  // MAX_OVERFLOW clamp: the inner-loop Jaccard budget is bounded by
  // MAX_OVERFLOW (alias for MAX_DREAM_ENTRIES) regardless of how high
  // `maxEntries` is configured. Without this clamp, a misconfigured
  // value would push the O(n²) dedup/cluster loops past the
  // production budget. The skip message preserves the original
  // `maxEntries` so operators can still see what was configured.
  const effectiveCap = Math.min(maxEntries, MAX_OVERFLOW);
  if (rows.length > effectiveCap) {
    return {
      kind: "skip",
      scanned: rows.length,
      skipMsg: `Skipped: ${rows.length} entries exceed MAX_DREAM_ENTRIES (${maxEntries})`,
    };
  }

  return { kind: "ok", rows, tokenCache: tokenizeRowsToCache(rows) };
}

/** Phase 1 helper: load every memory row ordered newest-first. Pure DB
 *  read — no cap check, no tokenization. The orchestrator decides
 *  whether to short-circuit on cap before calling `tokenizeRowsToCache`. */
export function loadMemoryRows(db: Database): MemoryRow[] {
  return db
    .query("SELECT * FROM memory_entries ORDER BY created_at DESC")
    .all() as MemoryRow[];
}

/** Phase 1 helper: pre-tokenize each row once into a map keyed by row id.
 *  The dedup + cluster loops would otherwise call tokenize() on the same
 *  content O(n) times each — O(n²) total regex + Set allocations. With
 *  this cache, tokenize runs O(n) times and every comparison is O(1)
 *  (jaccardSets). v0.14.x: 3-5x speedup observed on 1000+ entry workloads. */
export function tokenizeRowsToCache(rows: MemoryRow[]): Map<number, Set<string>> {
  const cache = new Map<number, Set<string>>();
  for (const row of rows) {
    cache.set(row.id, tokenize(row.content));
  }
  return cache;
}

// ---------------------------------------------------------------------------
// Phase 2: Jaccard-similarity dedup
// ---------------------------------------------------------------------------

/** Phase 2: Jaccard-similarity dedup. For every pair above
 *  `dedupThreshold`, mark the older one (by last_accessed or created_at,
 *  falling back to array order on ties) for deletion. Pure — does not
 *  touch the DB; the caller iterates the returned set to issue DELETEs. */
export function dedupRows(
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
        // Keep newer (by rowTimestamp — last_accessed ?? created_at); delete older.
        // Timestamps are in s (SQLite strftime('%s','now')).
        const timeI = rowTimestamp(rows[i]);
        const timeJ = rowTimestamp(rows[j]);
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

/** Phase 2 helper: the "effective timestamp" for a memory row used by
 *  the dedup decision — `last_accessed` if set, else `created_at`. The
 *  fallback is what makes `last_accessed === null` rows dedup-against
 *  their `created_at` peer correctly when both rows lack accesses. */
function rowTimestamp(row: MemoryRow): number {
  return row.last_accessed ?? row.created_at;
}

// ---------------------------------------------------------------------------
// Phase 3: stale removal
// ---------------------------------------------------------------------------

/** Phase 3: stale removal query. Two SELECTs — one for entries with
 *  `last_accessed < threshold` and one for entries where `last_accessed`
 *  IS NULL and `created_at < threshold`. Returns the concatenated list;
 *  the caller iterates to archive + delete. */
export function findStaleEntries(
  db: Database,
  staleThresholdSec: number,
): MemoryRow[] {
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

// ---------------------------------------------------------------------------
// Phase 4: re-read post-dedup+stale + rebuild token cache
// ---------------------------------------------------------------------------

/** Phase 4 helper: re-read the DB post-dedup+stale (or simulate the
 *  filtering in dry-run mode) and produce the post-state row set. The
 *  non-dry-run branch orders by `importance_score DESC` so the cluster
 *  loop iterates high-importance rows first. */
export function loadRemainingRows(
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
export function rebuildTokenCache(
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