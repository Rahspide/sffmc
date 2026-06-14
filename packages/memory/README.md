# @sffmc/memory

F4' Memory — FTS5 full-text search + ICM extraction (W1).

## What it does

Gives your agent persistent memory across sessions. Indexes project docs (`memory-bank/*.md`, `AGENTS.md`, root `*.md`) into an FTS5 SQLite database and injects a structured "Context Recon" block at the start of each session. A chokidar watcher re-indexes changed files. The recon block is composed of top-importance memory rows, an `AGENTS.md` parse, and a tail of recent messages — all sized by the per-section budget.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode-sandbox/opencode.json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/memory/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/memory.yaml`:

```yaml
# F4' Memory plugin config
storage_path: ~/.local/share/SFFMC/memory/index.sqlite
recon_budgets:
  memory: 6144
  checkpoint: 6144
  task_tree: 4096
  tail: 8192
  agents: 8192
memory_paths:
  - memory-bank/
  - AGENTS.md
  - "*.md"
default_importance: 0.5
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Initialize FTS5 DB and start chokidar watcher |
| `event` | Mark `reconNeededThisSession` on `session.created` |
| `experimental.chat.messages.transform` | Build Context Recon block, unshift as system message (once per session) |

## Tests

```bash
bun test packages/memory/
```

19 tests in `src/index.test.ts`.

## License

MIT
