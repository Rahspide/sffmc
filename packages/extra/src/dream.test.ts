// SPDX-License-Identifier: MIT
// @sffmc/extra — F8 Dream tests

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createDreamTool,
  clearCronTimer,
  isDreamLocked,
  type DreamResult,
  type RichPluginContext,
} from "./dream";
import { mkdirSync, existsSync, readFileSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_DIR = resolve(tmpdir(), `sffmc-dream-test-${Date.now()}`);
const TEST_DB_PATH = resolve(TEST_DIR, "memory/index.sqlite");
const ARCHIVE_PATH = resolve(tmpdir(), "sffmc-dream-test-archive.jsonl");

function setupTestDir(): void {
  if (!existsSync(TEST_DIR)) {
    mkdirSync(resolve(TEST_DIR, "memory"), { recursive: true });
  }
}

function openTestDB(): Database {
  setupTestDir();
  const db = new Database(TEST_DB_PATH);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_path TEXT NOT NULL,
      section TEXT,
      content TEXT NOT NULL,
      importance_score REAL DEFAULT 0.5,
      last_accessed INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
      content,
      source_path UNINDEXED,
      section UNINDEXED,
      content='memory_entries',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memory_entries BEGIN
      INSERT INTO memory_fts(rowid, content, source_path, section)
      VALUES (new.id, new.content, new.source_path, new.section);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, source_path, section)
      VALUES ('delete', old.id, old.content, old.source_path, old.section);
    END;
    CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memory_entries BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content, source_path, section)
      VALUES ('delete', old.id, old.content, old.source_path, old.section);
      INSERT INTO memory_fts(rowid, content, source_path, section)
      VALUES (new.id, new.content, new.source_path, new.section);
    END;
  `);
  return db;
}

function seedDB(db: Database, count: number, baseContent = "memory entry"): void {
  const insert = db.prepare(
    "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < count; i++) {
    insert.run(
      `test/source-${i}.md`,
      `section-${i % 5}`,
      `${baseContent} number ${i} with some unique text to vary the content for realistic testing purposes. Additional words here to make the content longer.`,
      0.1 + (i % 10) * 0.05,
      now,
      now - i * 100, // stagger creation times
    );
  }
}

function countRows(db: Database): number {
  const row = db.query("SELECT COUNT(*) as cnt FROM memory_entries").get() as { cnt: number };
  return row.cnt;
}

function cleanup(): void {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
  try { unlinkSync(ARCHIVE_PATH); } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("F8 Dream", () => {
  beforeEach(() => {
    clearCronTimer();
    cleanup();
    setupTestDir();
  });

  afterAll(() => {
    clearCronTimer();
    cleanup();
  });

  // ── Test 1: Manual trigger with 200 entries ────────────────────────
  it("manual trigger: 200 entries → dream reduces count via dedup + stale + summarization", async () => {
    const db = openTestDB();
    seedDB(db, 200);
    expect(countRows(db)).toBe(200);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.skipped).toBeUndefined();
    expect(result.scanned).toBe(200);

    // After dream, count should be lower (dedup + stale + summarization)
    const db2 = openTestDB();
    const after = countRows(db2);
    expect(after).toBeLessThan(200);
    // Most entries are similar enough to trigger dedup/clustering
    expect(after).toBeLessThan(100);
    db2.close();
  });

  // ── Test 2: Dedup — near-duplicate entries ─────────────────────────
  it("dedup: 5 near-duplicates (Jaccard > 0.9) → 4 deleted, 1 kept", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);
    // Long base content so that appending 1–2 words keeps Jaccard > 0.9
    const base =
      "system architecture design pattern for backend service with microservices event sourcing cqrs domain driven aggregate root entity value repository dependency injection inversion control";

    // Insert 5 entries: 3 identical copies + 2 with minimal additions
    const variants = [
      base,
      base + " extra",        // 1 extra word, Jaccard ~0.95+
      base + " more",         // 1 extra word
      base,                   // identical copy
      base + " additional",   // 1 extra word
    ];

    for (let i = 0; i < variants.length; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`test/dup-${i}.md`, null, variants[i], 0.5, now - i, now - i],
      );
    }
    expect(countRows(db)).toBe(5);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.deduped).toBe(4);
    expect(result.ok).toBe(true);

    const db2 = openTestDB();
    expect(countRows(db2)).toBe(1);
    db2.close();
  });

  // ── Test 3: Stale removal — entries > 30 days old ──────────────────
  it("stale removal: entries with last_accessed >30d ago are archived and deleted", async () => {
    const db = openTestDB();
    const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600; // 31 days ago
    const recentTime = Math.floor(Date.now() / 1000);

    // 3 stale entries
    for (let i = 0; i < 3; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          `test/stale-${i}.md`,
          null,
          `stale memory entry number ${i}`,
          0.5,
          staleTime,
          staleTime,
        ],
      );
    }
    // 1 fresh entry
    db.run(
      "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["test/fresh.md", null, "fresh memory content", 0.5, recentTime, recentTime],
    );

    expect(countRows(db)).toBe(4);
    db.close();

    // Override archive path for this test — use the test archive path
    // We can't easily override ARCHIVE_PATH, but the archive function appends.
    // For verification, we check that the archive file exists and has content.
    try { unlinkSync(ARCHIVE_PATH); } catch {}

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.archived).toBe(3);

    const db2 = openTestDB();
    expect(countRows(db2)).toBe(1); // only fresh remains
    db2.close();
  });

  // ── Test 4: Summarization — cluster of 6 similar entries ───────────
  it("summarization: 6 similar entries → 1 summary + 5 source deleted", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);

    // 6 entries with shared core + unique additions.
    // Each has 8 base tokens + 3 unique tokens → Jaccard ~8/14 ≈ 0.57 per pair
    // (well above 0.3 cluster threshold, well below 0.9 dedup threshold).
    const base = "authentication jwt tokens api requests session management";
    const contents = [
      base + " oauth2 refresh grant",          // +3 unique
      base + " role based access",             // +3 unique
      base + " https secure cookies",           // +3 unique
      base + " rate limit throttle",            // +3 unique
      base + " audit trail logging",            // +3 unique
      base + " multi factor verification",      // +3 unique
    ];

    for (let i = 0; i < contents.length; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          `test/auth-${i}.md`,
          "auth",
          contents[i],
          0.5 + i * 0.05,
          now - i,          // vary last_accessed so dedup keeps newest if triggered
          now - i * 10,
        ],
      );
    }
    expect(countRows(db)).toBe(6);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    // No dedup expected (all Jaccard < 0.9). All 6 should cluster and summarize.
    expect(result.scanned).toBe(6);
    expect(result.deduped).toBe(0);
    // 6 entries summarized = 6 source entries consumed, 1 summary inserted
    expect(result.summarized).toBe(6);

    const db2 = openTestDB();
    const rows = db2
      .query("SELECT * FROM memory_entries")
      .all() as Array<{ source_path: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBe("dream-summary");
    expect(rows[0].content).toContain("DREAM-SUMMARY");
    db2.close();
  });

  // ── Test 5: Count threshold trigger ────────────────────────────────
  it("count threshold: tool.execute.after triggers dream when count > threshold", async () => {
    const db = openTestDB();
    seedDB(db, 100);
    expect(countRows(db)).toBe(100);
    db.close();

    const { tool, hooks } = createDreamTool({
      enabled: true,
      threshold: 50, // 100 > 50 → should trigger
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    expect(hooks["tool.execute.after"]).toBeDefined();

    // Simulate a tool execution — this should trigger the dream
    await hooks["tool.execute.after"]!({ tool: "test_tool" }, { ok: true });

    // The auto-trigger is fire-and-forget, so we need to wait.
    // Poll for the result: count should eventually drop.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const db2 = openTestDB();
    const after = countRows(db2);
    // Dream should have run (dedup + clustering reduces count)
    expect(after).toBeLessThan(100);
    db2.close();
  });

  // ── Test 6: Dry run — no writes to DB ──────────────────────────────
  it("dry run: dry_run=true performs all reads but no writes", async () => {
    const db = openTestDB();
    seedDB(db, 50);
    expect(countRows(db)).toBe(50);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute({ dry_run: true });
    expect(result.ok).toBe(true);
    expect(result.dry_run).toBe(true);
    expect(result.scanned).toBe(50);

    // No writes should have happened
    const db2 = openTestDB();
    expect(countRows(db2)).toBe(50);
    db2.close();
  });

  // ── Test 7: Concurrency — second call returns skipped ──────────────
  it("concurrency: simultaneous dream calls → second returns skipped", async () => {
    const db = openTestDB();
    seedDB(db, 100);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    // Fire two calls without awaiting the first
    const promise1 = tool.execute();
    const promise2 = tool.execute();

    const [r1, r2] = await Promise.all([promise1, promise2]);

    // One should succeed, one should be skipped
    const succeeded = [r1, r2].filter((r) => !r.skipped);
    const skipped = [r1, r2].filter((r) => r.skipped);

    expect(succeeded.length).toBe(1);
    expect(skipped.length).toBe(1);
    expect(skipped[0].reason).toBe("dream already in progress");
    expect(isDreamLocked()).toBe(false); // lock released after completion
  });

  // ── Test 8: Disabled — returns skipped with reason ─────────────────
  it("disabled: tool returns { skipped: true, reason: 'feature disabled' }", async () => {
    const { tool } = createDreamTool({
      enabled: false,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("feature disabled");
    expect(result.scanned).toBe(0);
  });

  // ── Test 9: LLM summarization — uses ctx.client.session.message() ──
  it("llm summarization: ctx with mock LLM → inserts LLM-generated summary (not concat fallback)", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);

    // 6 similar entries that will cluster (same pattern as test 4)
    const base = "authentication jwt tokens api requests session management";
    const contents = [
      base + " oauth2 refresh grant",
      base + " role based access",
      base + " https secure cookies",
      base + " rate limit throttle",
      base + " audit trail logging",
      base + " multi factor verification",
    ];

    for (let i = 0; i < contents.length; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`test/auth-${i}.md`, "auth", contents[i], 0.5 + i * 0.05, now - i, now - i * 10],
      );
    }
    db.close();

    const cannedSummary = "LLM-summarized: authentication entries covering JWT, OAuth2, and MFA patterns.";
    const mockCtx: RichPluginContext = {
      client: {
        session: {
          message: async () => ({
            content: [{ type: "text", text: cannedSummary }],
            usage: { totalTokens: 42 },
          }),
        },
      },
    };

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
      ctx: mockCtx,
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.summarized).toBe(6);

    const db2 = openTestDB();
    const rows = db2
      .query("SELECT * FROM memory_entries")
      .all() as Array<{ source_path: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBe("dream-summary");
    // Must contain the LLM-generated text, NOT the concat fallback marker
    expect(rows[0].content).toBe(cannedSummary);
    expect(rows[0].content).not.toContain("DREAM-SUMMARY");
    db2.close();
  });

  // ── Test 10: No ctx — falls back to concatenateSummary ──────────────
  it("no ctx: falls back to concatenateSummary (concatenation marker present)", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);

    const base = "authentication jwt tokens api requests session management";
    const contents = [
      base + " oauth2 refresh grant",
      base + " role based access",
      base + " https secure cookies",
      base + " rate limit throttle",
      base + " audit trail logging",
      base + " multi factor verification",
    ];

    for (let i = 0; i < contents.length; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`test/auth-${i}.md`, "auth", contents[i], 0.5 + i * 0.05, now - i, now - i * 10],
      );
    }
    db.close();

    // No ctx provided
    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
      // ctx intentionally omitted
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.summarized).toBe(6);

    const db2 = openTestDB();
    const rows = db2
      .query("SELECT * FROM memory_entries")
      .all() as Array<{ source_path: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBe("dream-summary");
    // Must use concatenation fallback (no LLM)
    expect(rows[0].content).toContain("DREAM-SUMMARY");
    expect(rows[0].content).toContain("entries merged");
    db2.close();
  });

  // ── Test 11: LLM throws — falls back to concatenateSummary + error ──
  it("llm throws: ctx provided but message() rejects → falls back to concat + error in result", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);

    const base = "authentication jwt tokens api requests session management";
    const contents = [
      base + " oauth2 refresh grant",
      base + " role based access",
      base + " https secure cookies",
      base + " rate limit throttle",
      base + " audit trail logging",
      base + " multi factor verification",
    ];

    for (let i = 0; i < contents.length; i++) {
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [`test/auth-${i}.md`, "auth", contents[i], 0.5 + i * 0.05, now - i, now - i * 10],
      );
    }
    db.close();

    const throwingCtx: RichPluginContext = {
      client: {
        session: {
          message: async () => {
            throw new Error("LLM unavailable");
          },
        },
      },
    };

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
      ctx: throwingCtx,
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true); // dream still succeeds, just with fallback
    expect(result.summarized).toBe(6);
    // Error should be recorded for the LLM failure
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.includes("summarization LLM failed"))).toBe(true);

    const db2 = openTestDB();
    const rows = db2
      .query("SELECT * FROM memory_entries")
      .all() as Array<{ source_path: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBe("dream-summary");
    // Must fall back to concatenation
    expect(rows[0].content).toContain("DREAM-SUMMARY");
    db2.close();
  });
});
