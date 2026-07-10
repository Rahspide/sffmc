// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream orchestrator
// Main entry point: `runDream` (full cycle) + `createDreamTool` (factory)
// + cron/lock state. Extracted from dream.ts (M-3 Wave 1).
//
// This module is the ONLY place that knows the full dream cycle
// sequence (load → dedup → stale → cluster → summarize). Sibling
// modules expose pure primitives; this wires them together.

import { Database } from "bun:sqlite";
import { createLogger, defaultFsOps, HOOK_TOOL_EXECUTE_AFTER, unixNow, type FsOps } from "@sffmc/utilities";
import { archiveEntry, openDB } from "./dream-db.ts";
import {
  dedupRows,
  findStaleEntries,
  loadAndCacheMemories,
  loadRemainingRows,
  rebuildTokenCache,
} from "./dream-dedup.ts";
import { clusterSimilarRows, makeDreamResult, processDreamClusters } from "./dream-clustering.ts";
import {
  DREAM_CLUSTER_THRESHOLD,
  DREAM_DEDUP_THRESHOLD,
  DREAM_LLM_SNIPPET_LENGTH,
  DREAM_SNIPPET_LENGTH,
  DEFAULT_ARCHIVE_PATH,
  DEFAULT_STORAGE_PATH,
  MAX_DREAM_ENTRIES,
  SECONDS_PER_STALE_WINDOW,
  STALE_DAYS,
  type DreamConfig,
  type DreamHooks,
  type DreamResult,
  type DreamTool,
} from "./dream-types.ts";

const log = createLogger("extra-dream");

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
 *   - The constant declarations above (`DREAM_DEDUP_THRESHOLD`,
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

/** Snapshot the active factory's state for tests that need to inspect
 *  internal slots (cronTimer, dreamLock) directly. Returns `null` when no
 *  factory is currently registered. The returned reference is live: if a
 *  new factory is later created, the captured reference still points at
 *  the previous factory's state — useful for asserting that the prior
 *  factory's slots were cleaned up by the new factory's setup path.
 *  Production code should use `clearCronTimer()` / `isDreamLocked()` for
 *  state mutations; this getter is a read-only introspection handle. */
export function snapshotActiveDreamState(): DreamInstanceState | null {
  return _activeDreamState;
}

// ---------------------------------------------------------------------------
// runDream — main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full dream cycle: scan → dedup → stale removal → summarization.
 * Returns DreamResult with counts and any errors.
 *
 *   HIGH migration: `dedupThreshold`, `clusterThreshold`,
 *  and `maxEntries` are now configurable (via DreamConfig). The exported
 *  module-level constants (`DREAM_DEDUP_THRESHOLD`, `DREAM_CLUSTER_THRESHOLD`,
 *  `MAX_DREAM_ENTRIES`) remain as the defaults — behavior is unchanged when
 *  the caller omits the new fields.
 *
 *   MEDIUM migration: `archivePath` is now configurable. The
 *  default `DEFAULT_ARCHIVE_PATH` (`~/.local/share/sffmc/extra/dream-archive.jsonl`)
 *  is used when the caller omits the field.
 *
 *   LOW migration: `snippetLength` (default
 *  `DREAM_SNIPPET_LENGTH` = 100, used by `concatenateSummary` and
 *  `nameClusterViaLLM`) and `llmSnippetLength` (default
 *  `DREAM_LLM_SNIPPET_LENGTH` = 200, used by `summarizeViaLLM`) are now
 *  configurable. Behavior is unchanged when the caller omits the new fields.
 */
export async function runDream(
  db: Database,
  dryRun: boolean,
  ctx?: import("@sffmc/utilities").RichPluginContext,
  summaryModel?: string,
  dedupThreshold: number = DREAM_DEDUP_THRESHOLD,
  clusterThreshold: number = DREAM_CLUSTER_THRESHOLD,
  maxEntries: number = MAX_DREAM_ENTRIES,
  archivePath: string = DEFAULT_ARCHIVE_PATH,
  snippetLength: number = DREAM_SNIPPET_LENGTH,
  llmSnippetLength: number = DREAM_LLM_SNIPPET_LENGTH,
  fs: FsOps = defaultFsOps,
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
        archiveEntry(entry, archivePath, fs);
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
// Factory + sub-helpers
// ---------------------------------------------------------------------------

export function createDreamTool(config: DreamConfig): {
  tool: DreamTool;
  hooks: DreamHooks;
} {
  const resolved = resolveDreamConfig(config);
  const { dbPath, dedupThreshold, clusterThreshold, maxEntries, archivePath, snippetLength, llmSnippetLength } = resolved;
  let db: Database | null = null;

  // Per-instance state (DLC: no shared state between plugins)
  const state: DreamInstanceState = {
    dreamLock: null,
    cronTimer: null,
  };
  // Multi-factory cron-timer cleanup: clear the PRIOR active factory's
  // cron timer (if any) BEFORE swapping _activeDreamState. Otherwise
  // each new factory leaves the previous factory's setInterval handle
  // alive but unreachable through the public API — the singleton
  // _activeDreamState only retains the latest factory's handle. The
  // fix is here (not in setupDreamCron) because setupDreamCron only
  // knows about its own `state`, not the prior factory's.
  if (_activeDreamState?.cronTimer != null) {
    clearInterval(_activeDreamState.cronTimer);
    _activeDreamState.cronTimer = null;
  }
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
    const skip = checkDreamSkipped(config, state);
    if (skip) return skip;

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
      defaultFsOps,
    );
    try {
      const result = await state.dreamLock;
      return result;
    } finally {
      state.dreamLock = null;
    }
  }

  // ── Tool definition ─────────────────────────────────────────────
  const tool = buildDreamToolDefinition(config, executeDream);

  // ── Hooks ───────────────────────────────────────────────────────
  const hooks = buildDreamHooks(config, state, getDB, executeDream);

  // ── Cron schedule ───────────────────────────────────────────────
  setupDreamCron(state, config, executeDream);

  return { tool, hooks };
}

/** Resolve the factory-level config defaults so the resolved values are
 *  stable across the lifetime of the factory instance. The threshold /
 *  cap / archive-path / snippet-length fields are all defaulted here. */
function resolveDreamConfig(config: DreamConfig): {
  dbPath: string;
  dedupThreshold: number;
  clusterThreshold: number;
  maxEntries: number;
  archivePath: string;
  snippetLength: number;
  llmSnippetLength: number;
} {
  const dbPath = config.storagePath ?? DEFAULT_STORAGE_PATH;
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
  return {
    dbPath,
    dedupThreshold,
    clusterThreshold,
    maxEntries,
    archivePath,
    snippetLength,
    llmSnippetLength,
  };
}

/** Build the early-skip `DreamResult` for the two no-op paths:
 *  (a) the feature is disabled, (b) a dream is already in progress.
 *  Returns `null` when the caller should proceed to `runDream`. */
function checkDreamSkipped(
  config: DreamConfig,
  state: DreamInstanceState,
): DreamResult | null {
  if (!config.enabled) {
    return makeSkippedDreamResult("feature disabled");
  }
  if (state.dreamLock) {
    return makeSkippedDreamResult("dream already in progress");
  }
  return null;
}

/** Build the all-zeros `DreamResult` for the disabled / locked paths. */
function makeSkippedDreamResult(reason: string): DreamResult {
  return {
    scanned: 0,
    deduped: 0,
    archived: 0,
    summarized: 0,
    durationMs: 0,
    errors: [],
    ok: true,
    skipped: true,
    reason,
  };
}

/** Build the tool definition (description + JSON schema + execute wrapper). */
function buildDreamToolDefinition(
  config: DreamConfig,
  executeDream: (dryRun?: boolean) => Promise<DreamResult>,
): DreamTool {
  return {
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
}

/** Build the count-threshold hook. When `config.enabled` is false the hook
 *  is a no-op. When the row count exceeds `config.threshold`, fire-and-forget
 *  triggers `executeDream(false)` so the tool pipeline isn't blocked. */
function buildDreamHooks(
  config: DreamConfig,
  _state: DreamInstanceState,
  getDB: () => Database,
  executeDream: (dryRun?: boolean) => Promise<DreamResult>,
): DreamHooks {
  return {
    [HOOK_TOOL_EXECUTE_AFTER]: async (_toolCtx: unknown, _result: unknown) => {
      if (!config.enabled) return;
      try {
        const count = countMemoryRows(getDB);
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
}

/** Count rows in memory_entries. Returns 0 when the COUNT(*) returns
 *  NULL (the query's max aggregate value is always numeric, so this is
 *  just a defensive narrowing). Pure DB read — no mutation. */
function countMemoryRows(getDB: () => Database): number {
  const row = getDB()
    .query("SELECT COUNT(*) as cnt FROM memory_entries")
    .get() as { cnt: number } | null;
  return row?.cnt ?? 0;
}

/** Install the cron timer when the feature is enabled and an interval is
 *  configured. Clears any previous timer on the same state (tests may
 *  call `createDreamTool` multiple times). The timer is unref'd (when
 *  available) so it does not keep the process alive; no OpenCode
 *  shutdown hook exists, so the timer is intentionally leaked on
 *  process exit and cleaned up by the runtime. */
function setupDreamCron(
  state: DreamInstanceState,
  config: DreamConfig,
  executeDream: (dryRun?: boolean) => Promise<DreamResult>,
): void {
  if (!config.enabled || config.intervalHours <= 0) return;
  if (state.cronTimer !== null) {
    clearInterval(state.cronTimer);
  }
  const intervalMs = config.intervalHours * 3600 * 1000;
  state.cronTimer = setInterval(
    () => cronTickBody(config.intervalHours, executeDream),
    intervalMs,
  );
  if (typeof state.cronTimer.unref === "function") {
    state.cronTimer.unref();
  }
}

/** Body of the cron setInterval callback. Logs the trigger and
 *  fire-and-forget runs `executeDream(false)` so the timer tick never
 *  blocks. Kept separate so setupDreamCron reads top-down and the
 *  trigger shape can be unit-tested in isolation. */
function cronTickBody(
  intervalHours: number,
  executeDream: (dryRun?: boolean) => Promise<DreamResult>,
): void {
  log.info(`dream: cron triggered (${intervalHours}h interval)`);
  executeDream(false).catch((err) => {
    log.error("dream: cron error:", err);
  });
}