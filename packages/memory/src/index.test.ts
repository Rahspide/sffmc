import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  init,
  upsert,
  search,
  all,
  topByImportance,
  remove,
  type MemoryDB,
} from "./memory";
import { buildRecon, tailFromMessages, parseAgentsMd } from "./recon";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/sffmc-memory-test.sqlite";

function cleanup() {
  try { unlinkSync(TEST_DB); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + "-wal"); } catch { /* ok */ }
  try { unlinkSync(TEST_DB + "-shm"); } catch { /* ok */ }
}

describe("MemoryDB", () => {
  let db: MemoryDB;

  beforeEach(() => {
    cleanup();
    db = init(TEST_DB);
  });

  afterEach(cleanup);

  it("creates schema without error", () => {
    const tables = db.db
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("memory_entries");
    expect(names).toContain("memory_fts");
  });

  it("upserts a new entry", () => {
    upsert(db, "docs/test.md", "intro", "hello world", 0.7);
    const entries = all(db);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("hello world");
    expect(entries[0].source_path).toBe("docs/test.md");
    expect(entries[0].importance_score).toBe(0.7);
  });

  it("upsert updates existing entry by source+section", () => {
    upsert(db, "a.md", "s1", "first", 0.5);
    upsert(db, "a.md", "s1", "second", 0.8);
    const entries = all(db);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe("second");
    expect(entries[0].importance_score).toBe(0.8);
  });

  it("upsert creates separate rows for different sections", () => {
    upsert(db, "a.md", "s1", "one", 0.5);
    upsert(db, "a.md", "s2", "two", 0.5);
    expect(all(db).length).toBe(2);
  });

  it("searches via FTS5", () => {
    upsert(db, "a.md", "s1", "hello world", 0.5);
    upsert(db, "b.md", "s2", "goodbye moon", 0.5);
    upsert(db, "c.md", "s3", "hello again sunshine", 0.5);

    const results = search(db, "hello", 10);
    expect(results.length).toBe(2);
    const contents = results.map((r) => r.content);
    expect(contents).toContain("hello world");
    expect(contents).toContain("hello again sunshine");
  });

  it("removes entries by source path", () => {
    upsert(db, "a.md", "s1", "hello", 0.5);
    upsert(db, "a.md", "s2", "world", 0.5);
    upsert(db, "b.md", "s1", "keep", 0.5);

    remove(db, "a.md");
    const remaining = all(db);
    expect(remaining.length).toBe(1);
    expect(remaining[0].source_path).toBe("b.md");
  });

  it("topByImportance returns highest first", () => {
    upsert(db, "a.md", "s1", "low", 0.1);
    upsert(db, "b.md", "s2", "mid", 0.5);
    upsert(db, "c.md", "s3", "high", 0.9);

    const top = topByImportance(db, 2);
    expect(top.length).toBe(2);
    expect(top[0].content).toBe("high");
    expect(top[1].content).toBe("mid");
  });

  it("all returns entries ordered by created_at DESC", async () => {
    upsert(db, "a.md", "s1", "first", 0.5);
    await new Promise((r) => setTimeout(r, 1100)); // ensure distinct timestamps
    upsert(db, "b.md", "s2", "second", 0.5);
    const entries = all(db);
    expect(entries[0].content).toBe("second");
  });
});

describe("buildRecon", () => {
  it("assembles recon block within budgets", () => {
    const memory = [
      {
        id: 1,
        source_path: "memory-bank/progress.md",
        section: "progress",
        content: "Phase 1 complete",
        importance_score: 0.9,
        last_accessed: null,
        created_at: 1000,
      },
    ];
    const result = buildRecon(
      memory,
      "last checkpoint text",
      "task: implement X",
      "recent messages here",
      "# AGENTS.md content",
    );
    expect(result).toContain("Context Recon 8K");
    expect(result).toContain("## Memory");
    expect(result).toContain("## Checkpoint");
    expect(result).toContain("## Task Tree");
    expect(result).toContain("## Recent Context");
    expect(result).toContain("## AGENTS.md");
    expect(result.length).toBeLessThanOrEqual(40000);
  });

  it("truncates oversize sections", () => {
    const memory = [
      {
        id: 1,
        source_path: "x.md",
        section: "x",
        content: "x".repeat(10000),
        importance_score: 0.5,
        last_accessed: null,
        created_at: 1000,
      },
    ];
    const result = buildRecon(memory, null, "", "", "");
    const memSection = result.match(/## Memory[\s\S]*?(?=\n## |$)/)?.[0] ?? "";
    expect(memSection.length).toBeLessThanOrEqual(6144 + 50);
    expect(result).toContain("[...truncated]");
  });
});

describe("tailFromMessages", () => {
  it("extracts last N chars from messages", () => {
    const messages = [
      { role: "user", content: "short" },
      { role: "assistant", content: "a".repeat(100) },
      { role: "user", content: "b".repeat(100) },
    ];
    const tail = tailFromMessages(messages, 50);
    expect(tail.length).toBeLessThanOrEqual(50 + 20); // +20 for truncation suffix
  });

  it("skips messages without content", () => {
    const messages = [
      { role: "user" },
      { role: "assistant", content: "hello" },
    ];
    const tail = tailFromMessages(messages, 100);
    expect(tail).toContain("hello");
  });
});

describe("parseAgentsMd", () => {
  it("returns content truncated to budget", () => {
    const long = "x".repeat(10000);
    const result = parseAgentsMd(long);
    expect(result.length).toBe(8192);
  });

  it("returns full content if under budget", () => {
    const result = parseAgentsMd("short");
    expect(result).toBe("short");
  });
});

describe("Plugin entry", () => {
  it("exports default object with id and server function", async () => {
    const mod = await import("./index");
    expect(mod.default).toBeDefined();
    expect(mod.default.id).toBe("@sffmc/memory");
    expect(typeof mod.default.server).toBe("function");
  });

  it("server returns hooks with config, event, and messages.transform", async () => {
    const mod = await import("./index");
    const hooks = await mod.default.server({
      projectRoot: "/tmp/test-project",
      config: {},
    });
    expect(typeof hooks.config).toBe("function");
    expect(typeof hooks.event).toBe("function");
    expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function");
  });
});
