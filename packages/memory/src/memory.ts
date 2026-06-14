import { Database } from "bun:sqlite";

export interface MemoryEntry {
  id: number;
  source_path: string;
  section: string | null;
  content: string;
  importance_score: number;
  last_accessed: number | null;
  created_at: number;
}

export class MemoryDB {
  constructor(public db: Database) {}
}

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

export function init(dbPath: string): MemoryDB {
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA_SQL);
  return new MemoryDB(db);
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
