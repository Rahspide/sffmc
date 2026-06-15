# packages/memory/src/ — Source Files

## Responsibility

Implementation of the `@sffmc/memory` OpenCode plugin. Contains the SQLite memory store (FTS5-indexed, dual-runtime), the Context Recon block builder (5-section Markdown injection), the chokidar file watcher, and the plugin entry point that wires hooks to the OpenCode lifecycle.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry point. Registers 3 OpenCode hooks (`config`, `event`, `experimental.chat.messages.transform`). Lazy-initializes DB + watcher. On session start, builds and injects Context Recon system message from top memories + AGENTS.md + message tail |
| `memory.ts` | SQLite store. Runtime-adaptive loader (bun:sqlite → node:sqlite fallback), adapter normalizing both backends. Exports `init`, `upsert`, `remove`, `search`, `all`, `topByImportance`, `MemoryDB`, `MemoryEntry`. Schema: `memory_entries` table + `memory_fts` FTS5 virtual table + 3 sync triggers |
| `recon.ts` | Context Recon block builder. `buildRecon()` assembles 5 sections (Memory, Checkpoint, Task Tree, Recent Context, AGENTS.md) with per-section `truncate()` at newline boundaries. `tailFromMessages()` walks newest-to-oldest for recent context. `parseAgentsMd()` budget-trims AGENTS.md |
| `watcher.ts` | Chokidar file watcher. Watches `memory-bank/*.md`, `AGENTS.md`, `*.md` under project root. On add/change: reads file, calls `determineSection()` for section name, calls `upsert()`. On unlink: calls `remove()`. Returns `{ stop }` for cleanup |
| `index.test.ts` | 19 tests (bun:test). Covers: schema creation, CRUD (upsert/update/delete/search/topByImportance/all ordering), recon block assembly + truncation, tailFromMessages extraction, parseAgentsMd budget, runtime guard (bun:sqlite resolution), adapter .run() param normalization, plugin export shape + hook signatures |

## Design Patterns

- **FTS5 indexing with trigger sync** — `memory_fts` virtual table (content=`memory_entries`, content_rowid=`id`) kept in sync via `AFTER INSERT`/`AFTER DELETE`/`AFTER UPDATE` triggers. FTS index maintains `rank` for relevance-sorted search results
- **Dual-runtime SQLite loader** — `resolveEngine()` tries `import("bun:sqlite")` first (3-6x faster), falls back to `import("node:sqlite")` (Node 22.6+ built-in `DatabaseSync`). Resolution is lazy (first `init()` call), promise-deduped (`_resolvePromise` prevents concurrent resolution)
- **Adapter normalizes API differences** — bun:sqlite natively supports `db.query(sql).all()/.get()` and `db.run(sql, [params])`. node:sqlite exposes `db.prepare(sql)` and run is on the statement. Adapter wraps node:sqlite: `query()` → `prepare()`, `run()` → `prepare().run(...params)` with spread for array params
- **Upsert on composite key** — `(source_path, section)` is the logical unique key. `SELECT` first, `UPDATE` if found (refreshing `last_accessed`), `INSERT` if new. Avoids `INSERT OR REPLACE` which would change `id` and break FTS rowid mapping
- **Section inference from path** — `determineSection()`: `memory-bank/progress.md` → `progress`, `memory-bank/activeContext.md` → `activeContext`, `AGENTS.md` → `agents`, root `README.md` → `README`
- **Budgeted truncation** — `truncate()` cuts at `maxChars` but prefers newline boundaries. If a newline exists after 80% of budget, truncates there to preserve line integrity. Appends `[...truncated]` marker
- **Recon injection gate** — boolean flags `reconNeededThisSession` (set by `session.created` event) and `reconInjectedThisSession` (set after first injection) ensure exactly one recon per session, even if transform hook fires multiple times
- **Best-effort error handling** — recon injection is wrapped in try/catch with silent return. If DB is unavailable or AGENTS.md is missing, the session proceeds without recon — never blocks the agent

## Data & Control Flow

### Initialization sequence
```
server(ctx)
  → loadConfig("memory", defaultConfig)  // @sffmc/shared, YAML merge
  → state = { db:null, watcher:null, reconNeeded:false, reconInjected:false, config }

config hook fires:
  → ensureDB()
      → resolveEngine()     // import bun:sqlite || import node:sqlite
      → new Database(path), PRAGMA journal_mode=WAL
      → exec(SCHEMA_SQL)    // memory_entries + memory_fts + 3 triggers
      → createAdapter(rawDb, isBun)  // normalize API
      → state.db = new MemoryDB(adapted)
  → ensureWatcher()
      → startWatcher(projectRoot, db)
          → chokidar.watch(patterns, { persistent, ignoreInitial:false, awaitWriteFinish })
          → on "add"    → indexFile → readFile → determineSection → upsert
          → on "change" → indexFile → (same)
          → on "unlink" → remove(db, relPath)
          → return { stop: watcher.close }
```

### Recon injection sequence
```
session.created event:
  → state.reconNeededThisSession = true

experimental.chat.messages.transform fires:
  guard: reconNeeded && !reconInjected ? continue : return
  → ensureDB()
  → memory = topByImportance(db, 20)              // MemoryEntry[]
  → agents = parseAgentsMd(readFileSync(AGENTS.md)) // string, ≤8192 chars
  → tail = tailFromMessages(messages.slice(-20), budget) // last 20 msgs, ≤8192 chars
  → recon = buildRecon(memory, null, "", tail, agents)
      → "## Memory"    (≤6144 chars)
      → "## Task Tree" (≤4096 chars, "(empty)" placeholder)
      → "## Recent Context" (≤8192 chars)
      → "## AGENTS.md" (≤8192 chars)
  → messages.unshift({ role: "system", content: recon })
  → reconInjected = true, reconNeeded = false
```

### Watcher file lifecycle
```
File add/change:
  → readFileSync(path, "utf-8")
  → skip if empty
  → relPath = relative(rootDir, path)
  → section = determineSection(path, rootDir)
      memory-bank/a/b.md → "a/b"
      AGENTS.md          → "agents"
      README.md          → "README"
  → upsert(db, relPath, section, content, defaultImportance=0.5)
      SELECT id WHERE source_path=? AND section=?
      → found → UPDATE content, importance, last_accessed
      → not found → INSERT
  → FTS5 AFTER INSERT/UPDATE trigger fires → syncs memory_fts

File delete:
  → relPath = relative(rootDir, path)
  → remove(db, relPath) → DELETE FROM memory_entries WHERE source_path=?
  → FTS5 AFTER DELETE trigger fires → removes from memory_fts
```

### SQLite schema
```sql
-- Main table (content store)
memory_entries (id INTEGER PK, source_path TEXT, section TEXT,
                content TEXT, importance_score REAL DEFAULT 0.5,
                last_accessed INTEGER, created_at INTEGER)

-- FTS5 virtual table (search index)
memory_fts USING fts5(content, source_path UNINDEXED, section UNINDEXED,
                      content='memory_entries', content_rowid='id')

-- 3 triggers keep FTS in sync: memory_ai (after insert),
-- memory_ad (after delete), memory_au (after update)
```

## OpenCode Hooks

| Hook | File | Behavior |
|---|---|---|
| `config` | index.ts | Idempotent: opens FTS5 DB (WAL), starts chokidar watcher. `ensureDB()` + `ensureWatcher()` guard against double-init |
| `event` | index.ts | Listens for `session.created` string. Sets `reconNeededThisSession = true`, resets `reconInjectedThisSession = false` |
| `experimental.chat.messages.transform` | index.ts | Once per session: queries top 20 memories, reads AGENTS.md, extracts last 20 message tail, builds 5-section recon block, unshifts as `role: "system"` message. Best-effort: catches errors silently |

## Integration Points

| Dependency | Used In | How |
|---|---|---|
| `@sffmc/shared` | index.ts | `loadConfig<MemoryConfig>("memory", defaults)` — reads `~/.config/SFFMC/memory.yaml`. `PluginContext` type for `projectRoot` |
| `chokidar` ^4.0.0 | watcher.ts | `.watch()` with persistent + awaitWriteFinish (300ms/100ms) |
| `yaml` ^2.0.0 | (via @sffmc/shared) | YAML config parsing |
| `bun:sqlite` | memory.ts | Primary engine. `Database` class, `.query()`, `.run()` |
| `node:sqlite` | memory.ts | Fallback engine. `DatabaseSync` class, wrapped via adapter |
| `fs` (node) | index.ts, watcher.ts | `readFileSync`, `existsSync`, `mkdirSync` |
| `path` (node) | index.ts, watcher.ts | `resolve`, `dirname`, `relative`, `basename` |
| `os` (node) | index.ts | `homedir()` for default storage path |
| **Consumer** | — | OpenCode plugin loader via `file://` path in `plugin[]` array |

## Internal Symbols

| Symbol | File | Kind | Visibility |
|---|---|---|---|
| `MemoryConfig` | index.ts | interface | local |
| `PluginState` | index.ts | interface | local |
| `defaultConfig` | index.ts | const | local |
| `ensureDir` | index.ts | function | local |
| `ensureDB` | index.ts | closure | local (inside server) |
| `ensureWatcher` | index.ts | closure | local (inside server) |
| `DatabaseCtor` | memory.ts | let | module-private |
| `_resolvePromise` | memory.ts | let | module-private |
| `resolveEngine` | memory.ts | async function | module-private |
| `createAdapter` | memory.ts | function | module-private |
| `SCHEMA_SQL` | memory.ts | const | module-private |
| `truncate` | recon.ts | function | module-private |
| `determineSection` | watcher.ts | function | module-private |
| `indexFile` | watcher.ts | closure | local (inside startWatcher) |
