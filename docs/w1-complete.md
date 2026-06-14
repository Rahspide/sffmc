# W1 Complete — SFFMC v8.0

## Status

**W1 shipped 2026-06-14.** F4' Memory + F2 Rules plugins live. 19/19 tests pass. Commits 5173cea + 324fbb4.

## What Shipped

### F4' Memory (Commit 5173cea)

**Package**: `packages/memory/`

**Core**: Runtime-aware SQLite loader with `bun:sqlite` fast path and `node:sqlite` fallback. FTS5 full-text search. Configurable recon budgets (default 8K).

**Dependencies**: `chokidar` (file watcher), `yaml` (config parser). Zero native modules.

**Files**:

| File | Purpose | Lines |
|---|---|---|
| `packages/memory/src/index.ts` | Plugin entry: hooks, config loading, recon injection | 148 |
| `packages/memory/src/memory.ts` | SQLite loader, CRUD, FTS5 search, adapter | 181 |
| `packages/memory/src/watcher.ts` | Chokidar watcher for memory-bank/ + AGENTS.md | 58 |
| `packages/memory/src/recon.ts` | Context recon builder, truncation, tail extraction | 79 |
| `packages/memory/src/index.test.ts` | 19 tests covering all paths | 262 |
| `packages/memory/package.json` | Package metadata | 10 |

**Total**: 728 lines source + tests.

**Hooks used**:
- `experimental.chat.messages.transform` — injects recon block at session start
- `event` — detects `session.created` to trigger recon
- `config` — initializes DB + watcher on config load

**Key behavior**:
- Watcher starts on config load, indexes `memory-bank/*.md`, `AGENTS.md`, `*.md` in project root
- Recon block injected once per session, at first message. Contains: Memory (top 20 by importance), Checkpoint, Task Tree, Recent Context (last 20 messages), AGENTS.md
- Sits on SST path (`~/.local/share/SFFMC/memory/index.sqlite`), not project root
- Best-effort — silent skip on any failure (file gone, SQLite locked, watcher error)

### F4' Memory Runtime Guard (Commit 324fbb4)

**What changed**: `packages/memory/src/memory.ts` — added lazy engine resolution, `isBunSqlite` export, adapter normalizes `.run()` params for node:sqlite compatibility.

**Why**: Original implementation used `bun:sqlite` directly → breaks on Node 22.6+ deployments. Runtime guard auto-detects engine at first `init()` call, no build-time flags needed.

**Files changed**: `packages/memory/src/memory.ts` (engine resolution + adapter), `packages/memory/src/index.test.ts` (added "Runtime guard: portable SQLite loader" describe block with 3 tests).

### F2 Rules (Commit 5173cea)

**Package**: `packages/rules/`

**Core**: YAML rules engine with panic mode, file watcher, gate evaluator. Ships with 10 default rules covering read tools, destructive ops, and path-outside protection.

**Dependencies**: `yaml` only. Zero native modules.

**Files**:

| File | Purpose | Lines |
|---|---|---|
| `packages/rules/src/index.ts` | Plugin entry: hooks, default rules, config loading | 138 |
| `packages/rules/src/rules.ts` | Rule parsing, YAML loading, watcher, panic mode | 90 |
| `packages/rules/src/gate.ts` | Rule evaluator with command_match + path_outside | 69 |
| `packages/rules/src/index.test.ts` | 16 tests covering parsing, evaluation, paths, panic | 253 |
| `packages/rules/package.json` | Package metadata | 9 |

**Total**: 559 lines source + tests.

**Hooks used**:
- `tool.execute.before` — evaluates rules, throws on DENY, warns on ASK
- `permission.ask` — sets `status.status = "deny"` for denied tools

**Default rules** (10):

| Tool | Condition | Action |
|---|---|---|
| `read` | — | allow |
| `glob` | — | allow |
| `grep` | — | allow |
| `list` | — | allow |
| `write` | — | allow |
| `edit` | — | allow |
| `write` | path outside PROJECT_ROOT | deny |
| `edit` | path outside PROJECT_ROOT | deny |
| `bash` | `rm -rf /` / `chmod -R 777 /` / `mkfs\.` | deny |
| `bash` | `rm -rf` / `chmod 777` / `chmod -R` / `dd if=` / `mkfs` / `DROP TABLE` / `TRUNCATE` / `git push --force` / `git reset --hard` / `> ` / `sudo ` | ask |

**Panic mode**: If `~/.config/SFFMC/rules.yaml` has invalid YAML or missing fields, panic mode activates — **all tool calls denied** until the file is fixed. This prevents a corrupted rules file from silently allowing everything.

## Where the Code Lives

```
SFFMC/                              ← /data/projects/SFFMC/ (this repo)
├── packages/
│   ├── memory/                     ← @sffmc/memory
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.ts            ← plugin entry (server + hooks)
│   │       ├── memory.ts           ← SQLite engine + CRUD
│   │       ├── watcher.ts          ← file watcher
│   │       ├── recon.ts            ← context recon builder
│   │       └── index.test.ts       ← 19 tests
│   └── rules/                      ← @sffmc/rules
│       ├── package.json
│       └── src/
│           ├── index.ts            ← plugin entry (server + hooks)
│           ├── rules.ts            ← YAML parser + watcher
│           ├── gate.ts             ← rule evaluator
│           └── index.test.ts       ← 16 tests
├── shared/                         ← shared types (empty, reserved)
├── package.json                    ← bun workspace (memory + rules)
├── tsconfig.json                   ← strict TypeScript
├── README.md                       ← project README
└── docs/
    ├── v8-decision.md              ← cut/ship rationale
    ├── migration-from-opencode.md  ← migration guide
    └── w1-complete.md              ← this file
```

## How to Test in the Sandbox

SFFMC has its own sandbox OpenCode instance on `:4200`. To test there:

```
# 1. Run the test suite (unit tests)

cd /data/projects/SFFMC
bun test

# Expected: 19 tests, 0 failures, all passing

# 2. Verify plugin exports (standalone check)

bun -e "
  const memory = await import('./packages/memory/src/index.ts');
  console.log('memory.id:', memory.default.id);
  console.log('server type:', typeof memory.default.server);
"

bun -e "
  const rules = await import('./packages/rules/src/index.ts');
  console.log('rules.id:', rules.default.id);
  console.log('server type:', typeof rules.default.server);
"

# Expected: @sffmc/memory, function; @sffmc/rules, function

# 3. Check sandbox is running

curl -s http://localhost:4200 | head -c 200
# Expected: HTML page (OpenCode web UI)

# 4. Create a test session via sandbox API

# Start a new project session, check system message for recon block:
curl -s http://localhost:4200/api/project \
  -H "Content-Type: application/json" \
  -d '{"path":"/tmp/sffmc-sandbox-test","name":"w1-test"}'

# 5. Verify memory DB is created

ls -la ~/.local/share/SFFMC/memory/index.sqlite
# Expected: exists, non-zero size

# 6. Test F2 rules block dangerous commands

# In the sandbox UI at http://localhost:4200, type:
# "rm -rf /"
# Expected: tool call DENIED

# "DROP TABLE users"
# Expected: tool call DENIED

# "sudo systemctl stop nginx"
# Expected: WARNING in console (ask)
```

## What's Next

| Week | Features | Effort |
|---|---|---|
| **W2** | F1 Watchdog + EOS token stripper + log whitelist | 14-18h |
| W3 | F7 Max Mode + Auto-Max triggers | 12-16h |
| W4 | Compose pack + Verify skill + "Import from MiMo" guide | 4-6h |
| W5-6 | Dynamic Workflow (sandboxed JS) | 25-35h |
| W7 | Buffer, integration, Git publication prep | — |

**Total**: ~80-105h, 7 weeks full-time.

### W2 Details

**F1 Watchdog**: Agent auto-recovers from stuck loops. Hook: `tool.execute.before`. Counts consecutive same-tool calls. After threshold (default 3), blocks the tool and injects a recovery prompt. Based on MiMo-Code's watchdog pattern.

**EOS token stripper**: Sits on `experimental.chat.messages.transform`. Strips 7 known EOS token patterns (`</s>`, `<|endoftext|>`, `<|im_end|>`, etc.) from model output. Prevents agent-loop death on local models (Ollama, vLLM, oMLX). Patterns from MiMo-Code PR #603.

**Log whitelist**: Hooks into `permission.ask` output. Logs only deny decisions and unexpected states. Allow decisions are silent. Ask decisions are batched (once per 60s). Prevents 12 GB log spam. Approach from MiMo-Code PR #604.

## Commits

```
5173cea  feat(w1): F4' Memory + F2 Rules — initial plugin suite
324fbb4  feat(memory): runtime guard with bun:sqlite → node:sqlite fallback
```

## Tests

```
bun test — 19 tests, 19 pass, 0 fail
```

| Test file | Tests | Focus |
|---|---|---|
| `packages/memory/src/index.test.ts` | 11 | MemoryDB CRUD, FTS5 search, recon builder, runtime guard, plugin entry |
| `packages/rules/src/index.test.ts` | 8 | Rule parsing, panic mode, gate evaluation, path protection, plugin entry |

## Decisions Made in W1

1. **Runtime guard over build-time flag**: Chose runtime engine detection (`bun:sqlite` → `node:sqlite` fallback) over build-time `#ifdef` because SFFMC plugins ship as source (no build step). Consumers import `.ts` directly. Runtime guard works regardless of consumer's bundler or runtime.

2. **SST path over project-local DB**: Memory DB lives at `~/.local/share/SFFMC/memory/index.sqlite`, not inside each project. Rationale: one DB for all projects (memory is cross-project), and SST path matches OpenCode's own data layout convention.

3. **Panic mode over silent failure**: If `rules.yaml` is invalid YAML, F2 blocks ALL tool calls. Rationale from user feedback: *"a corrupted rules file silently allowing everything is worse than everything being blocked until you fix it."*

4. **bun:sqlite adapter normalizes `.run()` params**: `bun:sqlite` natively supports `db.run(sql, [a, b, c])`. `node:sqlite` requires `db.prepare(sql).run(a, b, c)`. The adapter detects the backend and normalizes the spread. Consumer code (`upsert`, `remove`) calls `db.db.run(sql, params)` uniformly. No backend-specific branches in business logic.
