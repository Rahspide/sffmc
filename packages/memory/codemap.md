# packages/memory/ — `@sffmc/memory`

## Responsibility

F4' Memory plugin. Provides persistent agent memory across sessions via an FTS5-indexed SQLite database. Watches project markdown files (`memory-bank/*.md`, `AGENTS.md`, `*.md`) for changes, indexes them, and injects a structured "Context Recon" system message at the start of each new session — composed of top-importance memories, an `AGENTS.md` parse, and a tail of recent messages, all sized by per-section character budgets.

## Design Patterns

- **FTS5 full-text search indexing** — virtual table `memory_fts` with AFTER INSERT/UPDATE/DELETE triggers keeping FTS index in sync with `memory_entries`
- **Recon injection** — `experimental.chat.messages.transform` hook builds a multi-section Markdown block (Memory, Checkpoint, Task Tree, Recent Context, AGENTS.md) and unshifts it as a system message once per session
- **Watcher with debounce** — chokidar persistent watcher with `awaitWriteFinish` (300ms stability threshold, 100ms poll). `ignoreInitial: false` indexes existing files on startup
- **Runtime-adaptive SQLite loader** — lazy resolution: `bun:sqlite` fast path (3-6x throughput) with fallback to `node:sqlite/DatabaseSync` (Node 22.6+ built-in, zero native deps). Resolved on first `init()` call
- **Adapter pattern** — `createAdapter()` normalizes bun:sqlite vs node:sqlite APIs. Both backends expose `.query(sql)` (returns `.all()/.get()/.run()`) and `.run(sql, params[])` (spread-corrected for node:sqlite where run lives on the statement, not the DB handle)
- **Lazy initialization state machine** — `ensureDB()` and `ensureWatcher()` are idempotent, called on first use. `reconNeededThisSession` / `reconInjectedThisSession` boolean flags prevent multiple recon injections per session
- **Upsert-on-composite-key** — `(source_path, section)` is the unique key. Insert if not found, update content + importance + last_accessed timestamp if exists
- **Section inference** — `determineSection()` derives section name from file path: `memory-bank/progress.md` → `progress`, `AGENTS.md` → `agents`, root `*.md` → basename without extension

## Data & Control Flow

```
Plugin load
  └─ server(ctx) called
       ├─ loadConfig("memory", defaultConfig) from @sffmc/shared (YAML: ~/.config/SFFMC/memory.yaml)
       └─ returns hooks object
            │
            ├─ [config hook]  ─── ensureDB() ──┬─ resolveEngine() → bun:sqlite | node:sqlite
            │                    │             ├─ new DatabaseCtor(path), PRAGMA journal_mode=WAL
            │                    │             ├─ exec(SCHEMA_SQL): tables + FTS5 + triggers
            │                    │             └─ createAdapter(rawDb, isBun) → MemoryDB
            │                    │
            │                    └─ ensureWatcher() ── startWatcher(rootDir, db)
            │                          ├─ chokidar.watch([memory-bank/*.md, AGENTS.md, *.md])
            │                          ├─ on "add"    → readFile → determineSection → upsert()
            │                          ├─ on "change" → readFile → determineSection → upsert()
            │                          └─ on "unlink" → remove(db, relPath)
            │
            ├─ [event hook]  ── on "session.created" → reconNeededThisSession = true
            │
            └─ [experimental.chat.messages.transform hook]
                 if reconNeeded && !reconInjected:
                   ├─ ensureDB() → topByImportance(db, 20)          → MemoryEntry[]
                   ├─ readFileSync(AGENTS.md) → parseAgentsMd()     → agents string (truncated)
                   ├─ tailFromMessages(messages.slice(-20), budget)  → tail string
                   ├─ buildRecon(memory, null, "", tail, agents)     → recon Markdown block
                   ├─ messages.unshift({ role: "system", content: recon })
                   └─ reconInjected = true, reconNeeded = false
```

### Memory entry lifecycle

```
File created/modified
  → watcher "add"/"change" event
  → readFileSync(path, "utf-8")
  → determineSection(path, rootDir)
  → upsert(db, relPath, section, content, defaultImportance)
       ├─ SELECT id WHERE source_path=? AND section=?
       ├─ if exists → UPDATE content, importance, last_accessed
       └─ if not    → INSERT
  → FTS5 triggers auto-sync virtual table

File deleted
  → watcher "unlink" event
  → remove(db, relPath)
       └─ DELETE FROM memory_entries WHERE source_path=?
  → FTS5 trigger auto-removes from virtual table
```

## OpenCode Hooks

| Hook | Purpose |
|---|---|
| `config` | Lazy-init: opens FTS5 SQLite database (WAL mode, schema + triggers), starts chokidar file watcher on project markdown files |
| `event` | Listens for `session.created` event; sets `reconNeededThisSession = true` to trigger recon on next transform |
| `experimental.chat.messages.transform` | Once per session: queries top-importance memories, reads AGENTS.md, extracts recent message tail, assembles Context Recon block, unshifts as system message |

## Integration Points

| Dependency | Role |
|---|---|
| `@sffmc/shared` (workspace:*) | `loadConfig<T>("memory", defaults)` — reads `~/.config/SFFMC/memory.yaml`, merges with defaults. `PluginContext` type with `projectRoot` and `config` fields |
| `chokidar` ^4.0.0 | Persistent file watcher for memory-bank/, AGENTS.md, *.md. Debounced via `awaitWriteFinish` (300ms stability) |
| `yaml` ^2.0.0 | YAML config parsing (used by @sffmc/shared internally) |
| `bun:sqlite` | Primary SQLite engine (Bun runtime). `Database` class with native `.query()` |
| `node:sqlite` (fallback) | Node 22.6+ built-in SQLite. `DatabaseSync` class, wrapped via adapter to match bun:sqlite API |
| Node `fs` | `readFileSync` (file reads), `existsSync`, `mkdirSync` (ensure storage dir) |
| Node `path` | `resolve`, `dirname`, `relative`, `basename` |
| Node `os` | `homedir()` for default storage path |
| **Consumer** | OpenCode plugin loader — loaded via `file:///.../src/index.ts` in `opencode.json` plugin array |

## Public API

### Types
- **`MemoryEntry`** — `{ id: number; source_path: string; section: string | null; content: string; importance_score: number; last_accessed: number | null; created_at: number }`
- **`MemoryDB`** — class wrapping adapted SQLite connection (`db: any`)
- **`MemoryConfig`** (local) — `{ storagePath, reconBudgets: { memory, checkpoint, taskTree, tail, agents }, memoryPaths, defaultImportance }`
- **`PluginState`** (local) — `{ db, watcher, reconNeededThisSession, reconInjectedThisSession, config }`

### Exported functions (memory.ts)
- **`init(dbPath: string): Promise<MemoryDB>`** — resolve engine, create/open DB, run schema, return wrapped handle
- **`upsert(db, source, section, content, importance?)`** — insert or update by (source_path, section) key
- **`remove(db, source)`** — delete all entries for a source path
- **`search(db, query, limit): MemoryEntry[]`** — FTS5 full-text search, ranked
- **`all(db): MemoryEntry[]`** — all entries, newest first
- **`topByImportance(db, limit): MemoryEntry[]`** — top-N by importance_score DESC

### Exported functions (recon.ts)
- **`buildRecon(memory, checkpoint, taskTree, tail, agents): string`** — assemble 5-section Context Recon Markdown block
- **`parseAgentsMd(content): string`** — truncate AGENTS.md to `RECON_BUDGETS.agents` chars
- **`tailFromMessages(messages, maxChars): string`** — extract recent message content within char budget, newest-first walk

### Exported functions (watcher.ts)
- **`startWatcher(rootDir, db): { stop: () => void }`** — start chokidar watcher, return stopper

### Exported constants
- **`RECON_BUDGETS`** — `{ memory: 6144, checkpoint: 6144, taskTree: 4096, tail: 8192, agents: 8192 }`
- **`isBunSqlite: boolean`** — which engine resolved (exported for test assertions)

### Plugin export (index.ts)
- **`default: { id: "@sffmc/memory", server }`** — OpenCode plugin entry point
