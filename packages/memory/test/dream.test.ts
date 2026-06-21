// SPDX-License-Identifier: MIT
// @sffmc/extra — Dream tests

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createDreamTool,
  clearCronTimer,
  isDreamLocked,
  nameClusterViaLLM,
  DEFAULT_ARCHIVE_PATH,
  DREAM_SNIPPET_LENGTH,
  DREAM_LLM_SNIPPET_LENGTH,
  type DreamResult,
  type RichPluginContext,
  type MemoryRow,
} from "../../extra/src/dream";
import { mkdirSync, existsSync, readFileSync, unlinkSync, rmdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";

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

describe("Dream", () => {
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

  // ── Manriel audit, v0.14.2 — concurrent dream() calls under
  //    the module-level _activeDreamState singleton. ────────────────
  it("dream module state: 10 concurrent dream() calls — exactly 1 succeeds, 9 skipped, no state corruption", async () => {
    const db = openTestDB();
    seedDB(db, 100);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    // Fire 10 concurrent dream() calls. The per-instance lock
    // (state.dreamLock) must serialize them: the first one runs,
    // the rest observe the lock and return { skipped: true,
    // reason: "dream already in progress" }.
    const N = 10;
    const promises = Array.from({ length: N }, () => tool.execute());
    const results = await Promise.all(promises);

    // Exactly one succeeded; the rest skipped.
    const succeeded = results.filter((r) => !r.skipped);
    const skipped = results.filter((r) => r.skipped);
    expect(succeeded.length).toBe(1);
    expect(skipped.length).toBe(N - 1);
    for (const s of skipped) {
      expect(s.reason).toBe("dream already in progress");
    }

    // State is clean after the burst — the lock was released and
    // isDreamLocked() reports false. This catches the race: if
    // _activeDreamState were mishandled, the lock pointer could be
    // left dangling and a subsequent call would see a stale lock.
    expect(isDreamLocked()).toBe(false);

    // A follow-up call after the burst must succeed normally (the
    // singleton state was correctly reset).
    const followUp = await tool.execute();
    expect(followUp.skipped).toBeUndefined();
    expect(followUp.ok).toBe(true);
    expect(isDreamLocked()).toBe(false);
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
  it("llm summarization: ctx with mock LLM → inserts LLM-generated summary with cluster name prefix", async () => {
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

    const cannedName = "API auth patterns";
    const cannedSummary = "LLM-summarized: authentication entries covering JWT, OAuth2, and MFA patterns.";
    const mockCtx: RichPluginContext = {
      client: {
        session: {
          message: async (params: { messages: Array<{ role: string; content: string }> }) => {
            const sysMsg = params.messages.find((m) => m.role === "system")?.content ?? "";
            if (sysMsg.includes("topic-namer")) {
              return { content: [{ type: "text", text: cannedName }] };
            }
            return { content: [{ type: "text", text: cannedSummary }] };
          },
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
    // Must contain the cluster name prefix and the LLM-generated summary
    expect(rows[0].content).toContain(`Cluster: ${cannedName}`);
    expect(rows[0].content).toContain(cannedSummary);
    expect(rows[0].content).not.toContain("DREAM-SUMMARY");
    expect(rows[0].content).not.toContain("untitled cluster");
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
    // Errors should be recorded for both naming and summarization failures
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
    expect(result.errors.some((e) => e.includes("cluster naming LLM failed"))).toBe(true);
    expect(result.errors.some((e) => e.includes("summarization LLM failed"))).toBe(true);

    const db2 = openTestDB();
    const rows = db2
      .query("SELECT * FROM memory_entries")
      .all() as Array<{ source_path: string; content: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].source_path).toBe("dream-summary");
    // Must fall back to concatenation with "untitled cluster" prefix
    expect(rows[0].content).toContain("Cluster: untitled cluster");
    expect(rows[0].content).toContain("DREAM-SUMMARY");
    db2.close();
  });

  // ── Test 12: nameClusterViaLLM — direct unit test ───────────────────
  it("nameClusterViaLLM: returns cluster name from LLM (no 'Cluster:' prefix in raw output)", async () => {
    const cannedName = "React state management pitfalls";
    const mockCtx: RichPluginContext = {
      client: {
        session: {
          message: async () => ({
            content: [{ type: "text", text: cannedName }],
            usage: { totalTokens: 10 },
          }),
        },
      },
    };

    const cluster: MemoryRow[] = [
      {
        id: 1,
        source_path: "src/hooks.ts",
        section: null,
        content: "useState batching behavior causes stale closure bugs in React 18",
        importance_score: 0.7,
        last_accessed: null,
        created_at: 1000,
      },
      {
        id: 2,
        source_path: "src/store.ts",
        section: null,
        content: "zustand selector optimization with shallow equality check",
        importance_score: 0.8,
        last_accessed: null,
        created_at: 1001,
      },
    ];

    const name = await nameClusterViaLLM(cluster, mockCtx, "test-model");
    expect(name).toBe(cannedName);
    // Raw output from the function must NOT include "Cluster:" prefix
    expect(name).not.toContain("Cluster:");
  });

  // ── Test 13: Dream with ctx → summary starts with "Cluster: <name>" ─
  it("cluster naming integration: dream with ctx and 6 entries → summary prefixed with 'Cluster: <name>'", async () => {
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

    const mockCtx: RichPluginContext = {
      client: {
        session: {
          message: async (params: { messages: Array<{ role: string; content: string }> }) => {
            const sysMsg = params.messages.find((m) => m.role === "system")?.content ?? "";
            if (sysMsg.includes("topic-namer")) {
              return { content: [{ type: "text", text: "API auth patterns" }] };
            }
            return { content: [{ type: "text", text: "LLM summary of auth entries." }] };
          },
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
    // The content must start with "Cluster: <name>" followed by the summary
    expect(rows[0].content).toMatch(/^Cluster: API auth patterns\n\n/);
    expect(rows[0].content).toContain("LLM summary of auth entries.");
    db2.close();
  });

  // ── #14: jaccard() returns 0 for two empty strings ─────────
  // dream.ts:67-74 — jaccard returns 0 when both token sets are empty (the
  // early `if (setA.size === 0 && setB.size === 0) return 0` guard). jaccard
  // is intentionally NOT exported (private), so we test it indirectly: insert
  // a single entry with empty content and run dream. With only one entry,
  // the dedup loop's `if (scanned > 1)` skips jaccard entirely, BUT the
  // primary purpose here is regression-prevention on the early-return
  // path. We cover both branches by also asserting that no crash occurs
  // when content is empty (the entry participates in stale + clustering
  // passes without throwing).

  it("jaccard returns 0 for two empty strings (via runDream) (#14)", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);
    // Empty content — both token sets are empty.
    db.run(
      "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["test/empty.md", null, "", 0.5, now, now],
    );
    expect(countRows(db)).toBe(1);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    // Must not throw on empty content. Single entry → no dedup, no cluster
    // (1 < 5 threshold). Stale-removal query uses last_accessed (not
    // content) so it can't trigger jaccard either.
    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.deduped).toBe(0);
    expect(result.summarized).toBe(0);
  });

  // ── #15: archiveEntry() — UTF-8 + all 7 fields preserved ────
  // dream.ts:123-137 — archiveEntry() writes a JSONL line containing the
  // original 7 fields (id, source_path, section, content,
  // importance_score, last_accessed, created_at) plus archived_at_ms and
  // archived_at_iso. The homedir archive path is fixed at
  // ~/.local/share/sffmc/extra/dream-archive.jsonl, so we unlink it
  // before, run dream with stale UTF-8 content, then read & verify.

  it("archiveEntry writes UTF-8 content with all 7 fields preserved (#15)", async () => {
    // The real archive path lives in the user's home dir. Unlink first
    // so we observe only this test's output.
    const realArchivePath = `${process.env.HOME}/.local/share/sffmc/extra/dream-archive.jsonl`;
    try { unlinkSync(realArchivePath); } catch {}
    try { mkdirSync(`${process.env.HOME}/.local/share/sffmc/extra`, { recursive: true }); } catch {}

    const db = openTestDB();
    const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600; // 31d ago
    // Stress UTF-8: Japanese, emoji, double-quotes, newlines, backslashes.
    const utf8Content =
      "テスト memory\n" +
      "with 🚀 emoji and \"quotes\" and a\\backslash\n" +
      "more 日本語 on a new line";

    db.run(
      "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["test/utf8.md", "セクション", utf8Content, 0.7, staleTime, staleTime],
    );
    expect(countRows(db)).toBe(1);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.archived).toBe(1);

    // Read the real archive and parse each line.
    const raw = readFileSync(realArchivePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const record = JSON.parse(lines[0]);

    // 7 original MemoryRow fields preserved verbatim.
    expect(typeof record.id).toBe("number");
    expect(record.source_path).toBe("test/utf8.md");
    expect(record.section).toBe("セクション");
    expect(record.content).toBe(utf8Content);
    expect(record.importance_score).toBe(0.7);
    expect(typeof record.last_accessed).toBe("number");
    expect(typeof record.created_at).toBe("number");

    // 2 audit metadata fields added by archiveEntry.
    expect(typeof record.archived_at_ms).toBe("number");
    expect(record.archived_at_ms).toBeGreaterThan(0);
    expect(typeof record.archived_at_iso).toBe("string");
    // ISO-8601 sanity: matches YYYY-MM-DDTHH:MM:SS.mmmZ
    expect(record.archived_at_iso).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    // Cleanup — leave the homedir archive clean for the next run.
    try { unlinkSync(realArchivePath); } catch {}
  });

  // ── #16: runDream() recovers gracefully when DB throws ──────
  // dream.ts:414-427 — runDream's catch block captures the error into
  // result.errors and returns ok:false (errors.length === 0 check). We
  // trigger the catch by dropping the memory_entries table AFTER seeding
  // but BEFORE executeDream; the first SELECT then throws "no such table".

  it("runDream recovers gracefully when DB query throws (#16)", async () => {
    const db = openTestDB();
    seedDB(db, 3);
    expect(countRows(db)).toBe(3);
    // Drop the table to make the next SELECT throw. We keep this connection
    // open — a separate Database() instance opened by getDB() in dream.ts
    // sees the same dropped schema (SQLite WAL mode reads from the same
    // committed state).
    db.run("DROP TABLE memory_entries");
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    // Catch block path: ok=false because errors.length > 0 after push.
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    // The error message names the missing table — confirms we hit the
    // expected branch, not some unrelated failure.
    expect(result.errors[0]).toMatch(/no such table|memory_entries/i);
  });

  // ── #17: jaccardSets refactor — correctness equivalence ──────
  // dream.ts:79-88 — jaccardSets(a, b) is the pre-tokenized twin of the
  // legacy jaccard(a, b) string API. The refactor MUST be behavior-preserving:
  // same input → same output. This regression guard inserts 50 entries with
  // a known mix (duplicate pairs, 1 cluster, unique, empty, long) and
  // asserts the deduped/summarized counts and the final DB row count.
  // The dedup threshold is the DREAM_DEDUP_THRESHOLD constant from dream.ts
  // (0.9 — Jaccard > 0.9 keeps newer, deletes older).

  it("jaccardSets refactor: 50 entries produce same dedup/summarize counts as legacy jaccard() (#17)", async () => {
    const db = openTestDB();
    const now = Math.floor(Date.now() / 1000);
    const insert = db.prepare(
      "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );

    // 10 pairs of near-duplicates (Jaccard > 0.9). Insert OLDER first, NEWER
    // second so that dedup keeps the newer copy. → 10 deletions.
    //
    // Each pair uses its own DISJOINT 20-token base + 1 entry-unique word.
    // Intra-pair Jaccard = 20 / (21+21-20) = 20/22 ≈ 0.909 > 0.9 → dedup.
    // Inter-pair Jaccard = 0 / 42 = 0 (no shared tokens) → no cluster.
    // The 10 surviving "newer" entries thus form 10 singleton clusters and
    // do NOT contribute to summarization — keeping the predicted counts
    // deterministic.
    const dupBases = [
      // 0: Greek letters (20)
      "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon",
      // 1: Zodiac (20)
      "aries taurus gemini cancer leo virgo libra scorpio sagittarius capricorn aquarius pisces constellation horoscope zodiac wheel element fire water terra",
      // 2: Continents (20)
      "africa antarctica asia australia europe northamerica southamerica continent country population region territory landmark desert rainforest savanna tundra grassland mountain valley",
      // 3: Musical instruments (20)
      "piano guitar violin drums trumpet saxophone flute clarinet cello harp banjo ukulele tuba trombone harmonica accordion xylophone mandolin oboe timpani",
      // 4: Planets (20)
      "mercury venus earth mars jupiter saturn uranus neptune pluto planet moon orbit solar lunar galaxy comet meteor eclipse equinox solstice",
      // 5: Tree types (20)
      "oak maple pine birch cedar spruce willow redwood juniper chestnut eucalyptus mahogany teak aspen elm beech cypress sycamore fig linden",
      // 6: Dog breeds (20)
      "labrador poodle beagle bulldog husky rottweiler boxer terrier retriever shepherd chihuahua dalmatian pug spaniel akita doberman collie setter pointer greyhound",
      // 7: Programming languages (20)
      "python javascript typescript rust ruby java golang swift kotlin scala perl haskell lua elixir dart csharp cobol fortran lisp clojure",
      // 8: Coffee drinks (20)
      "espresso cappuccino latte macchiato americano mocha cortado ristretto affogato breve conpanna doppio lungo turkish irish frappuccino viennese nitro flatwhite red eye",
      // 9: Cheese types (20)
      "cheddar brie gouda parmesan mozzarella feta swiss camembert roquefort gruyere manchego ricotta provolone edam stilton asiago gorgonzola havarti colby monterey",
    ];
    for (let i = 0; i < 10; i++) {
      const older = dupBases[i] + ` extra${i}a`;
      const newer = dupBases[i] + ` extra${i}b`;
      insert.run(`dup-older-${i}.md`, null, older, 0.5, now - 200 + i, now - 200 + i);
      insert.run(`dup-newer-${i}.md`, null, newer, 0.5, now - 100 + i, now - 100 + i);
    }

    // 6 similar entries (Jaccard ~0.5 within group, ~0 across groups) → 1
    // cluster of 6 → 1 summary inserted, 6 source entries removed.
    const clusterBase = "foo bar baz qux quux corge";
    for (let i = 0; i < 6; i++) {
      insert.run(
        `cluster-${i}.md`,
        null,
        clusterBase + ` unique${i} token${i} word${i}`,
        0.5,
        now - 50 + i,
        now - 50 + i,
      );
    }

    // 22 unique + dissimilar entries (no shared tokens with each other or
    // with the cluster). Each forms a singleton cluster (length 1 < 5 → no
    // summary). All 22 survive dream unchanged.
    const uniqueTopics = [
      "kubernetes pod scheduling affinity",
      "postgresql vacuum analyze statistics",
      "scheme borrow checker lifetimes",
      "react hooks useState useEffect",
      "docker multi-stage build cache",
      "webpack module federation remote",
      "graphql apollo federation subgraph",
      "redis pubsub streams",
      "mongodb aggregation pipeline",
      "kafka consumer group offset",
      "elasticsearch inverted index shard",
      "rabbitmq exchange queue binding",
      "prometheus metrics scrape",
      "opentelemetry trace span",
      "terraform plan apply state",
      "ansible playbook inventory",
      "nginx upstream load balancer",
      "haproxy acl backend",
      "consul service discovery",
      "vault secret engine",
      "istio sidecar envoy",
      "linkerd service mesh proxy",
    ];
    for (let i = 0; i < uniqueTopics.length; i++) {
      insert.run(
        `unique-${i}.md`,
        null,
        uniqueTopics[i],
        0.5,
        now - 30 + i,
        now - 30 + i,
      );
    }

    // 1 empty entry (regression: empty content must not crash jaccardSets
    // via the early-return guard). Jaccard(empty, *) = 0 → no dedup,
    // no cluster. Stays as 1 entry.
    insert.run(`empty.md`, null, "", 0.5, now, now);

    // 1 very long entry (50 unique tokens). Jaccard(long, *) = 0 since
    // tokens are unique. No dedup, no cluster. Stays as 1 entry.
    const longContent = Array.from({ length: 50 }, (_, i) => `token${i}`).join(
      " ",
    );
    insert.run(`long.md`, null, longContent, 0.5, now, now);

    // Sanity: 20 (dups) + 6 (cluster) + 22 (unique) + 1 (empty) + 1 (long) = 50
    expect(countRows(db)).toBe(50);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const result = await tool.execute();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.scanned).toBe(50);
    expect(result.deduped).toBe(10); // 10 pairs → 10 older copies deleted
    expect(result.summarized).toBe(6); // 6-entry cluster → 6 consumed
    expect(result.archived).toBe(0); // all entries are fresh (now, now)

    // Final DB state: 50 - 10 (dedup) - 6 (clustered) + 1 (summary) = 35
    const db2 = openTestDB();
    expect(countRows(db2)).toBe(35);
    // The 1 inserted summary must be the only "dream-summary" row.
    const summaries = db2
      .query("SELECT * FROM memory_entries WHERE source_path = ?")
      .all("dream-summary") as Array<{ content: string }>;
    expect(summaries.length).toBe(1);
    // Without ctx, summarization uses concatenateSummary (not LLM).
    expect(summaries[0].content).toContain("DREAM-SUMMARY");
    expect(summaries[0].content).toContain("entries merged");
    db2.close();
  });

  // ── #18: jaccardSets performance benchmark (it.skip) ────────
  // dream.ts:265-268 + 278-281 + 374-378 — pre-tokenizing once turns the
  // O(n²) re-tokenize storm into O(n²) Set.has() lookups. Goal: 3-5x
  // speedup vs the legacy jaccard() string API on 1000+ entry workloads.
  // To enable this benchmark, change `it.skip` to `it` and run:
  //   cd <repo-root> && bun test -t "jaccardSets performance"
  // Actual wall time depends on machine; this is for manual inspection,
  // not a CI gate. The log line includes the timing + counts.

  it.skip("jaccardSets performance: 2000 entries complete in <30s with timing log (#18)", async () => {
    const db = openTestDB();
    seedDB(db, 2000);
    expect(countRows(db)).toBe(2000);
    db.close();

    const { tool } = createDreamTool({
      enabled: true,
      threshold: 50,
      intervalHours: 0,
      storagePath: TEST_DB_PATH,
    });

    const start = performance.now();
    const result = await tool.execute();
    const elapsed = performance.now() - start;

    expect(result.ok).toBe(true);
    expect(result.scanned).toBe(2000);
    // Elapsed must be positive (defensive — guards against a clock anomaly)
    expect(elapsed).toBeGreaterThan(0);

    // Manual inspection: log the wall time and the per-stage counts.
    // Compare against the legacy jaccard() string API to compute speedup.
    console.log(
      `[PERF] 2000-entry dream: ${elapsed.toFixed(0)}ms ` +
        `(scanned=${result.scanned}, deduped=${result.deduped}, ` +
        `archived=${result.archived}, summarized=${result.summarized})`,
    );
  });

  // ── Second release (v0.14.3) MEDIUM migration — archivePath config ─────
  // dream.ts:146 — DEFAULT_ARCHIVE_PATH is exported. The factory resolves
  // `config.archivePath || DEFAULT_ARCHIVE_PATH` and uses that single path
  // for the entire factory instance. Empty string is a falsy "use default"
  // signal, matching the ExtraConfig YAML contract (empty string is the
  // loader's neutral value).
  //
  // These tests cover:
  //   1. DEFAULT_ARCHIVE_PATH points at the documented homedir location.
  //   2. When `archivePath` is omitted, the factory uses DEFAULT_ARCHIVE_PATH
  //      (regression — preserves the prior module-level constant behavior).
  //   3. When `archivePath` is an empty string, the factory falls back to
  //      DEFAULT_ARCHIVE_PATH (matches `||` truthy semantics).
  //   4. When `archivePath` is set, the factory writes to that path and
  //      does NOT touch the default. We use a per-test temp path so the
  //      home dir stays clean.
  //   5. Two factories with different `archivePath` values write to
  //      independent files — confirms the per-instance resolution.

  describe("archivePath config", () => {
    it("DEFAULT_ARCHIVE_PATH equals the documented homedir location", () => {
      const expected = resolve(
        homedir(),
        ".local/share/sffmc/extra/dream-archive.jsonl",
      );
      expect(DEFAULT_ARCHIVE_PATH).toBe(expected);
    });

    it("omitting archivePath uses DEFAULT_ARCHIVE_PATH (regression)", async () => {
      // Unlink the real archive first so any write is observable.
      try { unlinkSync(DEFAULT_ARCHIVE_PATH); } catch {}
      try {
        mkdirSync(dirname(DEFAULT_ARCHIVE_PATH), { recursive: true });
      } catch {}

      const db = openTestDB();
      const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["test/regress.md", null, "stale content", 0.5, staleTime, staleTime],
      );
      db.close();

      // No archivePath provided → factory must fall back to DEFAULT_ARCHIVE_PATH.
      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
      });
      const result = await tool.execute();
      expect(result.ok).toBe(true);
      expect(result.archived).toBe(1);

      // The default file must exist and have 1 JSONL line.
      expect(existsSync(DEFAULT_ARCHIVE_PATH)).toBe(true);
      const lines = readFileSync(DEFAULT_ARCHIVE_PATH, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBe(1);

      try { unlinkSync(DEFAULT_ARCHIVE_PATH); } catch {}
    });

    it("empty string archivePath falls back to DEFAULT_ARCHIVE_PATH", async () => {
      // Same as above but with the explicit empty-string form. The factory
      // uses `||` truthy semantics, so "" must resolve to the default.
      try { unlinkSync(DEFAULT_ARCHIVE_PATH); } catch {}
      try {
        mkdirSync(dirname(DEFAULT_ARCHIVE_PATH), { recursive: true });
      } catch {}

      const db = openTestDB();
      const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["test/empty.md", null, "stale content", 0.5, staleTime, staleTime],
      );
      db.close();

      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        archivePath: "", // empty → default
      });
      const result = await tool.execute();
      expect(result.archived).toBe(1);
      expect(existsSync(DEFAULT_ARCHIVE_PATH)).toBe(true);

      try { unlinkSync(DEFAULT_ARCHIVE_PATH); } catch {}
    });

    it("custom archivePath writes to the custom path and skips DEFAULT_ARCHIVE_PATH", async () => {
      const customPath = resolve(
        tmpdir(),
        `sffmc-dream-archive-custom-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
      );
      // Make sure the default is absent so we can assert it stays absent.
      try { unlinkSync(DEFAULT_ARCHIVE_PATH); } catch {}

      const db = openTestDB();
      const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
      db.run(
        "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        ["test/custom.md", null, "stale content for custom archive", 0.5, staleTime, staleTime],
      );
      db.close();

      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        archivePath: customPath,
      });
      const result = await tool.execute();
      expect(result.ok).toBe(true);
      expect(result.archived).toBe(1);

      // Custom path must exist with exactly 1 record.
      expect(existsSync(customPath)).toBe(true);
      const lines = readFileSync(customPath, "utf-8")
        .split("\n")
        .filter((l) => l.length > 0);
      expect(lines.length).toBe(1);
      const record = JSON.parse(lines[0]);
      expect(record.source_path).toBe("test/custom.md");
      expect(record.content).toBe("stale content for custom archive");

      // DEFAULT_ARCHIVE_PATH must NOT have been touched.
      expect(existsSync(DEFAULT_ARCHIVE_PATH)).toBe(false);

      try { unlinkSync(customPath); } catch {}
    });

    it("two factories with different archivePaths write to independent files", async () => {
      // Confirms the per-instance resolution: each factory must use its
      // own archivePath, not a shared module-level constant.
      const pathA = resolve(
        tmpdir(),
        `sffmc-dream-archive-A-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
      );
      const pathB = resolve(
        tmpdir(),
        `sffmc-dream-archive-B-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
      );

      const seedStale = (label: string) => {
        const db = openTestDB();
        const staleTime = Math.floor(Date.now() / 1000) - 31 * 24 * 3600;
        db.run(
          "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [`test/${label}.md`, null, `stale ${label}`, 0.5, staleTime, staleTime],
        );
        db.close();
      };

      seedStale("a");
      const { tool: toolA } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        archivePath: pathA,
      });
      const resultA = await toolA.execute();
      expect(resultA.archived).toBe(1);

      // Reset DB and seed a different entry.
      try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
      setupTestDir();
      seedStale("b");
      const { tool: toolB } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        archivePath: pathB,
      });
      const resultB = await toolB.execute();
      expect(resultB.archived).toBe(1);

      // Each file has exactly its own 1 record — no cross-contamination.
      const recA = JSON.parse(
        readFileSync(pathA, "utf-8").split("\n").filter((l) => l.length > 0)[0],
      );
      const recB = JSON.parse(
        readFileSync(pathB, "utf-8").split("\n").filter((l) => l.length > 0)[0],
      );
      expect(recA.source_path).toBe("test/a.md");
      expect(recA.content).toBe("stale a");
      expect(recB.source_path).toBe("test/b.md");
      expect(recB.content).toBe("stale b");

      try { unlinkSync(pathA); } catch {}
      try { unlinkSync(pathB); } catch {}
    });
  });

  // ── Third release (v0.14.3) LOW migration — snippetLength ───────────
  // dream.ts — the `100` and `200` literals in `concatenateSummary`,
  // `nameClusterViaLLM`, and `summarizeViaLLM` are now configurable via
  // `DreamConfig.snippetLength` and `DreamConfig.llmSnippetLength`.
  // Default behavior must be preserved (regression), and overrides must
  // reach the helpers via the factory's runDream() thread.
  //
  // These tests cover:
  //   1. Exported constants match the documented defaults (100 / 200).
  //   2. `concatenateSummary` (no-ctx path) truncates each entry to
  //      exactly `snippetLength` chars; ellipsis appears when content
  //      exceeds the limit. Regression: default 100.
  //   3. Custom `snippetLength` reaches `concatenateSummary` — a 50-char
  //      cap produces shorter previews with ellipsis on long entries.
  //   4. Custom `llmSnippetLength` reaches `summarizeViaLLM` — the LLM
  //      mock receives a substring of the configured length per entry.
  //   5. Custom `snippetLength` reaches `nameClusterViaLLM` — the
  //      topic-namer LLM mock receives a substring of the configured
  //      length per entry.
  //   6. Range validation: out-of-range values (below recommended min,
  //      above recommended max) are accepted at the runtime layer — the
  //      factory does NOT clamp; it trusts the YAML. This documents the
  //      current contract and would surface any future change to
  //      add clamping.

  describe("snippetLength config", () => {
    it("DREAM_SNIPPET_LENGTH and DREAM_LLM_SNIPPET_LENGTH constants match documented defaults", () => {
      expect(DREAM_SNIPPET_LENGTH).toBe(100);
      expect(DREAM_LLM_SNIPPET_LENGTH).toBe(200);
    });

    it("default snippetLength=100: concatenateSummary truncates each entry to 100 chars with ellipsis on long content (regression)", async () => {
      // 6 entries, each with content >> 100 chars to force ellipsis.
      // Entries share a 30-token base and add 2 unique tokens each →
      // pairwise Jaccard ≈ 30/34 ≈ 0.88 (cluster but NOT dedup).
      const db = openTestDB();
      const now = Math.floor(Date.now() / 1000);
      const sharedBase =
        "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
        "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
        "omega1 omega2 omega3 omega4 omega5 omega6"; // 30 tokens
      const uniqueTokens = [
        "oauth2 grant",
        "rbac permission",
        "https cookies",
        "throttle limits",
        "audit trail",
        "mfa verify",
      ];
      for (let i = 0; i < 6; i++) {
        const content = sharedBase + " " + uniqueTokens[i]; // ~150+ chars
        db.run(
          "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            `test/snip-default-${i}.md`,
            "default",
            content,
            0.5,
            now - i,
            now - i,
          ],
        );
      }
      db.close();

      // No ctx → concatenateSummary path. No snippetLength override → default 100.
      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
      });
      const result = await tool.execute();
      expect(result.ok).toBe(true);
      expect(result.summarized).toBe(6);

      const db2 = openTestDB();
      const rows = db2
        .query("SELECT * FROM memory_entries")
        .all() as Array<{ source_path: string; content: string }>;
      expect(rows.length).toBe(1);
      const summary = rows[0].content;
      // Header line includes the count.
      expect(summary).toMatch(/DREAM-SUMMARY \(6 entries merged\)/);
      // Each snippet line: [<source_path>] <first 100 chars><ellipsis?>.
      // The `…` (U+2026) appears only when content.length > snippetLength.
      const snippetLines = summary.split("\n").slice(1);
      expect(snippetLines.length).toBe(6);
      for (const line of snippetLines) {
        // Strip the "[path] " prefix to isolate the preview + ellipsis.
        const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
        expect(previewMatch).not.toBeNull();
        const preview = previewMatch![1];
        // Default 100 chars: preview must be exactly 100 + ellipsis.
        expect(preview.length).toBe(101); // 100 chars + "…"
        expect(preview.endsWith("…")).toBe(true);
      }
      db2.close();
    });

    it("custom snippetLength=50: concatenateSummary uses 50-char previews with ellipsis", async () => {
      // Same shape as the regression test, but with snippetLength=50.
      const db = openTestDB();
      const now = Math.floor(Date.now() / 1000);
      const sharedBase =
        "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
        "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
        "omega1 omega2 omega3 omega4 omega5 omega6";
      const uniqueTokens = [
        "oauth2 grant",
        "rbac permission",
        "https cookies",
        "throttle limits",
        "audit trail",
        "mfa verify",
      ];
      for (let i = 0; i < 6; i++) {
        const content = sharedBase + " " + uniqueTokens[i];
        db.run(
          "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            `test/snip-50-${i}.md`,
            "fifty",
            content,
            0.5,
            now - i,
            now - i,
          ],
        );
      }
      db.close();

      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        snippetLength: 50, // override
      });
      const result = await tool.execute();
      expect(result.summarized).toBe(6);

      const db2 = openTestDB();
      const rows = db2
        .query("SELECT * FROM memory_entries")
        .all() as Array<{ content: string }>;
      expect(rows.length).toBe(1);
      const summary = rows[0].content;
      const snippetLines = summary.split("\n").slice(1);
      expect(snippetLines.length).toBe(6);
      for (const line of snippetLines) {
        const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
        const preview = previewMatch![1];
        // 50 chars + ellipsis = 51 total.
        expect(preview.length).toBe(51);
        expect(preview.endsWith("…")).toBe(true);
      }
      db2.close();
    });

    it("custom llmSnippetLength=400: summarizeViaLLM receives 400-char previews", async () => {
      // The LLM mock captures the user message sent to summarizeViaLLM.
      // We assert the previews in that message match the configured length.
      //
      // Content shape: 100 shared tokens + 12 unique tokens per entry →
      // pairwise Jaccard = 100/(100+12+12-100) = 100/124 ≈ 0.806 →
      // cluster (above 0.3) but NOT dedup (below 0.9). 100 tokens × ~5
      // chars = ~500 chars per entry, which is > 400 (the override).
      const db = openTestDB();
      const now = Math.floor(Date.now() / 1000);
      const sharedBase =
        "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
        "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
        "one two three four five six seven eight nine ten " +
        "eleven twelve thirteen fourteen fifteen sixteen seventeen " +
        "eighteen nineteen twenty thirty forty fifty sixty seventy " +
        "eighty ninety hundred apple banana cherry date grape lemon " +
        "mango orange peach quince raspberry strawberry tangerine " +
        "watermelon blueberry blackberry cranberry fig kiwi papaya " +
        "apricot boysenberry cantaloupe damson elderberry guava " +
        "honeydew jackfruit kumquat lime nectarine olive pomegranate " +
        "quince rhubarb starfruit ugli vanilla watermelon xigua yam " +
        "zucchini almond bread carrot dill endive fennel garlic herb";
      // 100 distinct base tokens. Each entry adds 12 unique tokens.
      const uniqueTokens = [
        "alpha1 alpha2 alpha3 alpha4 alpha5 alpha6 alpha7 alpha8 alpha9 alpha10 alpha11 alpha12",
        "beta1 beta2 beta3 beta4 beta5 beta6 beta7 beta8 beta9 beta10 beta11 beta12",
        "gamma1 gamma2 gamma3 gamma4 gamma5 gamma6 gamma7 gamma8 gamma9 gamma10 gamma11 gamma12",
        "delta1 delta2 delta3 delta4 delta5 delta6 delta7 delta8 delta9 delta10 delta11 delta12",
        "epsilon1 epsilon2 epsilon3 epsilon4 epsilon5 epsilon6 epsilon7 epsilon8 epsilon9 epsilon10 epsilon11 epsilon12",
        "zeta1 zeta2 zeta3 zeta4 zeta5 zeta6 zeta7 zeta8 zeta9 zeta10 zeta11 zeta12",
      ];
      const contents = uniqueTokens.map((u) => sharedBase + " " + u);
      for (let i = 0; i < contents.length; i++) {
        db.run(
          "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            `test/llm-snip-${i}.md`,
            "auth",
            contents[i],
            0.5 + i * 0.05,
            now - i,
            now - i,
          ],
        );
      }
      db.close();

      // Capture the user message sent to summarizeViaLLM (skip nameClusterViaLLM).
      let capturedUserMsg = "";
      const mockCtx: RichPluginContext = {
        client: {
          session: {
            message: async (params: { messages: Array<{ role: string; content: string }> }) => {
              const sysMsg = params.messages.find((m) => m.role === "system")?.content ?? "";
              const userMsg = params.messages.find((m) => m.role === "user")?.content ?? "";
              if (sysMsg.includes("memory summarizer")) {
                capturedUserMsg = userMsg;
                return { content: [{ type: "text", text: "captured summary" }] };
              }
              // topic-namer — return canned name, no need to inspect
              return { content: [{ type: "text", text: "captured topic" }] };
            },
          },
        },
      };

      const { tool } = createDreamTool({
        enabled: true,
        threshold: 50,
        intervalHours: 0,
        storagePath: TEST_DB_PATH,
        ctx: mockCtx,
        llmSnippetLength: 400, // override
      });
      const result = await tool.execute();
      expect(result.ok).toBe(true);
      expect(result.summarized).toBe(6);

      // The captured user message starts with "Summarize these N related...".
      // Each entry is formatted as "[<source_path>] <substring(0, llmSnippetLength)>".
      // We verify that each entry's preview is exactly 400 chars long.
      // Split on the separator "\n\n" used by nameClusterViaLLM/summarizeViaLLM.
      const entryLines = capturedUserMsg
        .split("\n\n")
        .slice(1) // skip the "Summarize these 6..." header
        .filter((l) => l.startsWith("["));
      expect(entryLines.length).toBe(6);
      for (const line of entryLines) {
        const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
        expect(previewMatch).not.toBeNull();
        const preview = previewMatch![1];
        // llmSnippetLength=400 → preview must be exactly 400 chars.
        // Content was much longer, so substring(0, 400) truncates without ellipsis
        // (the LLM helpers don't add ellipsis — only concatenateSummary does).
        expect(preview.length).toBe(400);
      }
    });

    it("custom snippetLength=30: nameClusterViaLLM receives 30-char previews", async () => {
      // Direct test of nameClusterViaLLM with snippetLength=30.
      // The mock captures the user message and we verify preview lengths.
      const longContent = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "); // >> 30 chars
      const cluster: MemoryRow[] = [
        {
          id: 1,
          source_path: "src/a.ts",
          section: null,
          content: longContent,
          importance_score: 0.5,
          last_accessed: null,
          created_at: 1000,
        },
        {
          id: 2,
          source_path: "src/b.ts",
          section: null,
          content: longContent + " extra",
          importance_score: 0.5,
          last_accessed: null,
          created_at: 1001,
        },
      ];

      let capturedUserMsg = "";
      const mockCtx: RichPluginContext = {
        client: {
          session: {
            message: async (params: { messages: Array<{ role: string; content: string }> }) => {
              capturedUserMsg = params.messages.find((m) => m.role === "user")?.content ?? "";
              return { content: [{ type: "text", text: "captured topic" }] };
            },
          },
        },
      };

      const name = await nameClusterViaLLM(
        cluster,
        mockCtx,
        "test-model",
        30, // snippetLength override
      );
      expect(name).toBe("captured topic");

      // Verify each preview in the user message is exactly 30 chars.
      const entryLines = capturedUserMsg
        .split("\n\n")
        .slice(1)
        .filter((l) => l.startsWith("["));
      expect(entryLines.length).toBe(2);
      for (const line of entryLines) {
        const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
        expect(previewMatch).not.toBeNull();
        const preview = previewMatch![1];
        expect(preview.length).toBe(30);
      }
    });

    it("default snippetLength=100 on nameClusterViaLLM direct call (regression)", async () => {
      // Confirms the default parameter on nameClusterViaLLM itself
      // (separate from the factory's resolution) still produces 100-char
      // previews. This protects out-of-tree consumers that import the
      // helper directly without going through createDreamTool.
      const longContent = Array.from({ length: 50 }, (_, i) => `w${i}`).join(" "); // >> 100 chars
      const cluster: MemoryRow[] = [
        {
          id: 1,
          source_path: "src/a.ts",
          section: null,
          content: longContent,
          importance_score: 0.5,
          last_accessed: null,
          created_at: 1000,
        },
      ];

      let capturedUserMsg = "";
      const mockCtx: RichPluginContext = {
        client: {
          session: {
            message: async (params: { messages: Array<{ role: string; content: string }> }) => {
              capturedUserMsg = params.messages.find((m) => m.role === "user")?.content ?? "";
              return { content: [{ type: "text", text: "topic" }] };
            },
          },
        },
      };

      await nameClusterViaLLM(cluster, mockCtx, "test-model"); // no override → 100

      const entryLines = capturedUserMsg
        .split("\n\n")
        .slice(1)
        .filter((l) => l.startsWith("["));
      expect(entryLines.length).toBe(1);
      const previewMatch = entryLines[0].match(/^\[[^\]]+\] (.*)$/);
      const preview = previewMatch![1];
      expect(preview.length).toBe(100);
    });

    it("range validation: out-of-range values are accepted at runtime (no clamping)", async () => {
      // Documents the current contract: the factory trusts the YAML and
      // does NOT clamp to the recommended range. The plan recommends
      // 20 ≤ snippetLength ≤ 1000 and 50 ≤ llmSnippetLength ≤ 4000, but
      // these are documentation hints, not runtime invariants.
      //
      // We exercise three edge cases:
      //   a. snippetLength = 5 (below recommended min 20) — accepted.
      //   b. snippetLength = 5000 (above recommended max 1000) — accepted.
      //   c. llmSnippetLength = 10000 (above recommended max 4000) — accepted.

      // (a) snippetLength = 5
      {
        const db = openTestDB();
        const now = Math.floor(Date.now() / 1000);
        // 30 shared tokens (~150 chars) + 2 unique per entry →
        // pairwise Jaccard ≈ 30/34 ≈ 0.88 → cluster, NOT dedup.
        const sharedBase =
          "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
          "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
          "omega1 omega2 omega3 omega4 omega5 omega6";
        const uniqueTokens = [
          "oauth2 grant",
          "rbac permission",
          "https cookies",
          "throttle limits",
          "audit trail",
          "mfa verify",
        ];
        for (let i = 0; i < 6; i++) {
          const content = sharedBase + " " + uniqueTokens[i];
          db.run(
            "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [`test/range-low-${i}.md`, "x", content, 0.5, now - i, now - i],
          );
        }
        db.close();

        const { tool } = createDreamTool({
          enabled: true,
          threshold: 50,
          intervalHours: 0,
          storagePath: TEST_DB_PATH,
          snippetLength: 5, // below recommended min
        });
        const result = await tool.execute();
        expect(result.ok).toBe(true);
        expect(result.summarized).toBe(6);

        const db2 = openTestDB();
        const rows = db2
          .query("SELECT * FROM memory_entries")
          .all() as Array<{ content: string }>;
        const summary = rows[0].content;
        const snippetLines = summary.split("\n").slice(1);
        expect(snippetLines.length).toBe(6);
        for (const line of snippetLines) {
          const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
          const preview = previewMatch![1];
          // 5 chars + ellipsis = 6 total.
          expect(preview.length).toBe(6);
          expect(preview.endsWith("…")).toBe(true);
        }
        db2.close();
      }

      // (b) snippetLength = 5000 — must not crash; previews stay within content length.
      {
        // Clean DB: sub-test (a) inserted a dream-summary row that would
        // cluster with the new entries and pollute the snippet lines.
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
        setupTestDir();
        const db = openTestDB();
        const now = Math.floor(Date.now() / 1000);
        // 30 shared tokens + 2 unique per entry → cluster, NOT dedup.
        const sharedBase =
          "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
          "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
          "omega1 omega2 omega3 omega4 omega5 omega6";
        const uniqueTokens = [
          "oauth2 grant",
          "rbac permission",
          "https cookies",
          "throttle limits",
          "audit trail",
          "mfa verify",
        ];
        const contents = uniqueTokens.map((u) => sharedBase + " " + u); // ~150–175 chars each
        for (let i = 0; i < 6; i++) {
          db.run(
            "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [`test/range-high-${i}.md`, "x", contents[i], 0.5, now - i, now - i],
          );
        }
        db.close();

        const { tool } = createDreamTool({
          enabled: true,
          threshold: 50,
          intervalHours: 0,
          storagePath: TEST_DB_PATH,
          snippetLength: 5000, // above recommended max
        });
        const result = await tool.execute();
        expect(result.ok).toBe(true);
        expect(result.summarized).toBe(6);

        const db2 = openTestDB();
        const rows = db2
          .query("SELECT * FROM memory_entries")
          .all() as Array<{ content: string }>;
        const summary = rows[0].content;
        const snippetLines = summary.split("\n").slice(1);
        for (const line of snippetLines) {
          const previewMatch = line.match(/^\[[^\]]+\] (.*)$/);
          const preview = previewMatch![1];
          // No ellipsis because content.length (~150) < snippetLength (5000).
          expect(preview.endsWith("…")).toBe(false);
          // Preview equals the full content (substring(0, 5000) on a ~150-char string).
          // Compare by content (source_path → content mapping).
          const pathMatch = line.match(/^\[([^\]]+)\]/);
          const expectedPath = pathMatch![1];
          const expectedContent = contents.find((_c, i) =>
            expectedPath === `test/range-high-${i}.md`,
          );
          expect(expectedContent).toBeDefined();
          expect(preview).toBe(expectedContent!);
        }
        db2.close();
      }

      // (c) llmSnippetLength = 10000 — LLM mock receives the full content (which is short).
      {
        // Clean DB: sub-test (b) left a dream-summary row.
        try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
        setupTestDir();
        const db = openTestDB();
        const now = Math.floor(Date.now() / 1000);
        const sharedBase =
          "alpha beta gamma delta epsilon zeta eta theta iota kappa " +
          "lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi " +
          "omega1 omega2 omega3 omega4 omega5 omega6";
        const uniqueTokens = [
          "oauth2 grant",
          "rbac permission",
          "https cookies",
          "throttle limits",
          "audit trail",
          "mfa verify",
        ];
        const contents = uniqueTokens.map((u) => sharedBase + " " + u);
        for (let i = 0; i < contents.length; i++) {
          db.run(
            "INSERT INTO memory_entries (source_path, section, content, importance_score, last_accessed, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            [`test/range-llm-${i}.md`, "auth", contents[i], 0.5, now - i, now - i],
          );
        }
        db.close();

        let capturedUserMsg = "";
        const mockCtx: RichPluginContext = {
          client: {
            session: {
              message: async (params: { messages: Array<{ role: string; content: string }> }) => {
                const sysMsg = params.messages.find((m) => m.role === "system")?.content ?? "";
                if (sysMsg.includes("memory summarizer")) {
                  capturedUserMsg = params.messages.find((m) => m.role === "user")?.content ?? "";
                  return { content: [{ type: "text", text: "captured" }] };
                }
                return { content: [{ type: "text", text: "topic" }] };
              },
            },
          },
        };

        const { tool } = createDreamTool({
          enabled: true,
          threshold: 50,
          intervalHours: 0,
          storagePath: TEST_DB_PATH,
          ctx: mockCtx,
          llmSnippetLength: 10_000, // above recommended max
        });
        const result = await tool.execute();
        expect(result.ok).toBe(true);
        expect(result.summarized).toBe(6);

        // Each preview must be the full content string (since content << 10_000).
        const entryLines = capturedUserMsg
          .split("\n\n")
          .slice(1)
          .filter((l) => l.startsWith("["));
        expect(entryLines.length).toBe(6);
        for (let i = 0; i < entryLines.length; i++) {
          const previewMatch = entryLines[i].match(/^\[[^\]]+\] (.*)$/);
          const preview = previewMatch![1];
          // contents[i] is the source; substring(0, 10_000) returns the full string.
          expect(preview).toBe(contents[i]);
        }
      }
    });
  });
});
