// -------------------------------------------------------------------------
// Runtime-aware SQLite loader
//
// Fast path: bun:sqlite (Bun runtime, 3-6x node:sqlite throughput).
// Fallback:  node:sqlite/DatabaseSync (Node 22.6+ built-in, no native deps).
//
// Resolution is lazy — happens on first init() call.  This avoids top-level
// await issues with synchronous module consumers (plugin loaders, bundlers).
// -------------------------------------------------------------------------
let DatabaseCtor: any = null;
export let isBunSqlite = false;
let _resolvePromise: Promise<void> | null = null;

async function resolveEngine(): Promise<void> {
  if (DatabaseCtor) return; // already resolved
  if (_resolvePromise) return _resolvePromise;
  _resolvePromise = (async () => {
    try {
      const bunSqlite = await import("bun:sqlite");
      DatabaseCtor = bunSqlite.Database;
      isBunSqlite = true;
    } catch {
      // Fallback to Node 22.6+ built-in SQLite (DatabaseSync).
      // Same prepare()/all()/get()/run() API as better-sqlite3,
      // zero native compilation.
      const nodeSqlite = await import("node:sqlite");
      DatabaseCtor = nodeSqlite.DatabaseSync;
      isBunSqlite = false;
    }
  })();
  return _resolvePromise;
}

/**
 * Transparently adapts a raw SQLite connection so that consumer code can
 * call `.query(sql)` on both back-ends.  Internally:
 *
 *   bun:sqlite      → db.query(sql)            (native)
 *   node:sqlite     → db.prepare(sql)           (wrapped)
 *
 * Both return objects with .all(), .get(), .run().
 *
 * Additionally, `db.run(sql, [params])` — used directly on the bun
 * handle — is normalised for node:sqlite (which only offers
 * prepare().run()).
 */
function createAdapter(rawDb: any, _isBun: boolean): any {
  if (_isBun) return rawDb; // pass-through — bun:sqlite API matches our usage

  // node:sqlite (DatabaseSync) shim
  return {
    exec: (sql: string) => rawDb.exec(sql),
    query: (sql: string) => rawDb.prepare(sql),
    run: (sql: string, params?: any[]) => {
      if (params && params.length > 0) {
        rawDb.prepare(sql).run(...params);
      } else {
        rawDb.prepare(sql).run();
      }
    },
  };
}

// -------------------------------------------------------------------------
// Public types
// -------------------------------------------------------------------------
export interface MemoryEntry {
  id: number;
  source_path: string;
  section: string | null;
  content: string;
  importance_score: number;
  last_accessed: number | null;
  created_at: number;
}

export type MemoryDB = { db: any };

const SCHEMA_SQL = `
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
`;

export async function init(dbPath: string): Promise<MemoryDB> {
  await resolveEngine();
  const rawDb = new DatabaseCtor(dbPath);
  rawDb.exec("PRAGMA journal_mode=WAL;");
  rawDb.exec(SCHEMA_SQL);
  const adapted = createAdapter(rawDb, isBunSqlite);
  return { db: adapted };
}

export function upsert(
  db: MemoryDB,
  source: string,
  section: string,
  content: string,
  importance: number = 0.5,
): void {
  const existing = db.db
    .query("SELECT id FROM memory_entries WHERE source_path = ? AND section = ?")
    .get(source, section) as { id: number } | null;

  if (existing) {
    db.db.run(
      "UPDATE memory_entries SET content = ?, importance_score = ?, last_accessed = strftime('%s', 'now') WHERE id = ?",
      [content, importance, existing.id],
    );
  } else {
    db.db.run(
      "INSERT INTO memory_entries (source_path, section, content, importance_score) VALUES (?, ?, ?, ?)",
      [source, section, content, importance],
    );
  }
}

export function remove(db: MemoryDB, source: string): void {
  db.db.run("DELETE FROM memory_entries WHERE source_path = ?", [source]);
}

export function search(
  db: MemoryDB,
  query: string,
  limit: number,
): MemoryEntry[] {
  return db.db
    .query(
      `SELECT me.* FROM memory_entries me
       JOIN memory_fts mf ON me.id = mf.rowid
       WHERE memory_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as MemoryEntry[];
}

export function all(db: MemoryDB): MemoryEntry[] {
  return db.db
    .query("SELECT * FROM memory_entries ORDER BY created_at DESC")
    .all() as MemoryEntry[];
}

export function topByImportance(db: MemoryDB, limit: number): MemoryEntry[] {
  return db.db
    .query("SELECT * FROM memory_entries ORDER BY importance_score DESC LIMIT ?")
    .all(limit) as MemoryEntry[];
}
