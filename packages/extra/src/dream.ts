// SPDX-License-Identifier: MIT
// @sffmc/extra — F8 Dream
// Real background memory-cleaning service. Multi-trigger (count threshold,
// cron, manual tool), Jaccard dedup, stale removal >30d, cluster summarization.

import { Database } from "bun:sqlite";
import { mkdirSync, existsSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";

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

export interface RichPluginContext {
  client?: {
    session?: {
      message?(params: {
        messages: Array<{ role: string; content: string }>;
        model: string;
        temperature: number;
      }): Promise<{
        content: Array<{ type: string; text?: string }>;
        usage?: { totalTokens?: number };
      }>;
    };
  };
}

export interface DreamConfig {
  enabled: boolean;
  threshold: number;
  intervalHours: number;
  /** DB path override (for testing). Defaults to ~/.local/share/SFFMC/memory/index.sqlite */
  storagePath?: string;
  /** Plugin context for LLM-based summarization. When absent, falls back to concatenation. */
  ctx?: RichPluginContext;
  /** Model for LLM summarization. Defaults to "". */
  summaryModel?: string;
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
  "tool.execute.after"?: (toolCtx: unknown, result: unknown) => Promise<void>;
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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STORAGE_PATH = resolve(
  homedir(),
  ".local/share/SFFMC/memory/index.sqlite",
);
const ARCHIVE_PATH = resolve(
  homedir(),
  ".local/share/sffmc/extra/dream-archive.jsonl",
);
const STALE_DAYS = 30;

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
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  return db;
}

function ensureArchiveDir(): void {
  const dir = dirname(ARCHIVE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function archiveEntry(entry: MemoryRow): void {
  ensureArchiveDir();
  const record = {
    id: entry.id,
    source_path: entry.source_path,
    section: entry.section,
    content: entry.content,
    importance_score: entry.importance_score,
    last_accessed: entry.last_accessed,
    created_at: entry.created_at,
    archived_at_ms: Date.now(),
    archived_at_iso: new Date().toISOString(),
  };
  appendFileSync(ARCHIVE_PATH, JSON.stringify(record) + "\n");
}

/** Fallback summarization: concatenate first 100 chars of each entry */
function concatenateSummary(entries: MemoryRow[]): string {
  const snippets = entries.map((e) => {
    const text = e.content.substring(0, 100);
    const ellipsis = e.content.length > 100 ? "…" : "";
    return `[${e.source_path}] ${text}${ellipsis}`;
  });
  return `DREAM-SUMMARY (${entries.length} entries merged):\n${snippets.join("\n")}`;
}

/** LLM-based cluster naming: generates a 3-5 word topic phrase for a cluster. */
export async function nameClusterViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("ctx.client.session.message() not available");
  }
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, 100)}`,
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

/** LLM-based summarization: sends cluster entries to the model for a concise summary. */
async function summarizeViaLLM(
  cluster: MemoryRow[],
  ctx: RichPluginContext,
  model: string,
): Promise<string> {
  const session = ctx.client?.session;
  if (!session?.message) {
    throw new Error("ctx.client.session.message() not available");
  }
  const entries = cluster.map(
    (e) => `[${e.source_path}] ${e.content.substring(0, 200)}`,
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
 */
async function runDream(
  db: Database,
  dryRun: boolean,
  ctx?: RichPluginContext,
  summaryModel?: string,
): Promise<DreamResult> {
  const errors: string[] = [];
  const start = Date.now();
  let scanned = 0;
  let deduped = 0;
  let archived = 0;
  let summarized = 0;

  try {
    // ── 1. Read all memories ──────────────────────────────────────────
    const rows = db
      .query("SELECT * FROM memory_entries ORDER BY created_at DESC")
      .all() as MemoryRow[];
    scanned = rows.length;

    // ── 2. Dedup: Jaccard > 0.9, keep newer, delete older ─────────────
    const dedupSet = new Set<number>();
    if (scanned > 1) {
      for (let i = 0; i < rows.length; i++) {
        if (dedupSet.has(rows[i].id)) continue;
        for (let j = i + 1; j < rows.length; j++) {
          if (dedupSet.has(rows[j].id)) continue;
          if (rows[i].id === rows[j].id) continue;
          const sim = jaccard(rows[i].content, rows[j].content);
          if (sim > 0.9) {
            // Keep newer (by last_accessed or created_at); delete older.
            // Timestamps are in seconds (SQLite strftime('%s','now')).
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
      if (dedupSet.size > 0 && !dryRun) {
        for (const id of dedupSet) {
          db.run("DELETE FROM memory_entries WHERE id = ?", [id]);
        }
      }
    }
    deduped = dedupSet.size;

    // ── 3. Stale removal: last_accessed < now - 30 days ───────────────
    // created_at / last_accessed are Unix timestamps in seconds.
    const staleThresholdSec = Math.floor(Date.now() / 1000) - STALE_DAYS * 24 * 3600;

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

    const allStale = [...staleAccessed, ...staleNullAccessed];

    for (const entry of allStale) {
      if (!dryRun) {
        archiveEntry(entry);
        db.run("DELETE FROM memory_entries WHERE id = ?", [entry.id]);
      }
    }
    archived = allStale.length;

    // ── 4. Summarization: cluster by Jaccard > 0.3, summarize 5+ ──────
    // Re-read the DB to work on post-dedup+stale state.
    let remainingRows: MemoryRow[];
    if (!dryRun) {
      remainingRows = db
        .query("SELECT * FROM memory_entries ORDER BY importance_score DESC")
        .all() as MemoryRow[];
    } else {
      // Dry run: simulate what WOULD remain after dedup + stale removal
      const staleIds = new Set(allStale.map((e) => e.id));
      remainingRows = rows.filter(
        (r) => !dedupSet.has(r.id) && !staleIds.has(r.id),
      );
    }

    // Greedy clustering: for each unassigned row, start a cluster;
    // add any other row that has Jaccard > 0.3 with any cluster member.
    const clusters: MemoryRow[][] = [];
    const assigned = new Set<number>();

    for (const row of remainingRows) {
      if (assigned.has(row.id)) continue;
      const cluster: MemoryRow[] = [row];
      assigned.add(row.id);

      // Expand cluster (capped at 5 iterations to bound worst-case O(n³))
      let changed = true;
      for (let iter = 0; iter < 5 && changed; iter++) {
        changed = false;
        for (const other of remainingRows) {
          if (assigned.has(other.id)) continue;
          for (const member of cluster) {
            if (jaccard(member.content, other.content) > 0.3) {
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

    // Process clusters of 5+ entries
    for (const cluster of clusters) {
      if (cluster.length >= 5) {
        let summaryContent: string;
        let clusterName = "untitled cluster";

        if (ctx) {
          // Try to name the cluster via LLM
          try {
            clusterName = await nameClusterViaLLM(
              cluster,
              ctx,
              summaryModel ?? "",
            );
          } catch (err) {
            errors.push(
              `cluster naming LLM failed: ${String(err)}`,
            );
          }
          // Try to summarize via LLM
          try {
            summaryContent = await summarizeViaLLM(
              cluster,
              ctx,
              summaryModel ?? "",
            );
          } catch (err) {
            errors.push(
              `summarization LLM failed for cluster of ${cluster.length}: ${String(err)}`,
            );
            summaryContent = concatenateSummary(cluster);
          }
        } else {
          summaryContent = concatenateSummary(cluster);
        }

        const finalContent = ctx
          ? `Cluster: ${clusterName}\n\n${summaryContent}`
          : summaryContent;

        const maxImportance = Math.max(
          ...cluster.map((e) => e.importance_score),
        );
        if (!dryRun) {
          db.run(
            "INSERT INTO memory_entries (source_path, section, content, importance_score) VALUES (?, ?, ?, ?)",
            ["dream-summary", null, finalContent, maxImportance],
          );
          for (const entry of cluster) {
            db.run("DELETE FROM memory_entries WHERE id = ?", [entry.id]);
          }
        }
        summarized += cluster.length;
      }
    }

    const durationMs = Date.now() - start;
    return {
      scanned,
      deduped,
      archived,
      summarized,
      durationMs,
      errors,
      ok: true,
      dry_run: dryRun,
    };
  } catch (err) {
    errors.push(String(err));
    const durationMs = Date.now() - start;
    return {
      scanned,
      deduped,
      archived,
      summarized,
      durationMs,
      errors,
      ok: errors.length === 0,
      dry_run: dryRun,
    };
  }
}

// ---------------------------------------------------------------------------
// Concurrency lock & cron state (module-level)
// ---------------------------------------------------------------------------

let dreamLock: Promise<DreamResult> | null = null;
let cronTimer: ReturnType<typeof setInterval> | null = null;

/** Clear a previously-set cron timer (useful for tests). */
export function clearCronTimer(): void {
  if (cronTimer !== null) {
    clearInterval(cronTimer);
    cronTimer = null;
  }
}

/** Expose the dream lock so tests can inspect concurrency state. */
export function isDreamLocked(): boolean {
  return dreamLock !== null;
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
    if (dreamLock) {
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
    dreamLock = runDream(database, dryRun, config.ctx, config.summaryModel);
    try {
      const result = await dreamLock;
      return result;
    } finally {
      dreamLock = null;
    }
  }

  // ── Tool definition ─────────────────────────────────────────────
  const tool: DreamTool = {
    description: `F8 Dream — background memory cleaning.
Triggers: count>${config.threshold} OR ${config.intervalHours}h cron OR manual.
Actions: dedup (Jaccard > 0.9), stale removal (>${STALE_DAYS}d), cluster summarization (5+ similar).`,

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
    "tool.execute.after": async (_toolCtx: unknown, _result: unknown) => {
      if (!config.enabled) return;
      try {
        const database = getDB();
        const row = database
          .query("SELECT COUNT(*) as cnt FROM memory_entries")
          .get() as { cnt: number } | null;
        const count = row?.cnt ?? 0;
        if (count > config.threshold) {
          console.log(
            `[extra] dream: auto-triggered (count=${count} > threshold=${config.threshold})`,
          );
          // Fire-and-forget so the hook doesn't block the tool pipeline
          executeDream(false).catch((err) => {
            console.error("[extra] dream: auto-trigger error:", err);
          });
        }
      } catch (err) {
        console.error("[extra] dream: count check error:", err);
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
    if (cronTimer !== null) {
      clearInterval(cronTimer);
    }
    const intervalMs = config.intervalHours * 3600 * 1000;
    cronTimer = setInterval(() => {
      console.log(
        `[extra] dream: cron triggered (${config.intervalHours}h interval)`,
      );
      executeDream(false).catch((err) => {
        console.error("[extra] dream: cron error:", err);
      });
    }, intervalMs);
    if (typeof cronTimer.unref === "function") {
      cronTimer.unref();
    }
  }

  return { tool, hooks };
}
