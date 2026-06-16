# @sffmc/memory

> **This is the memory MSP.** It composes 4 sub-features: `memory-core` (F4' SQLite + recon), `checkpoint` (F5' opt-in), `judge` (F6' opt-in), and `dream` (F8 opt-in). All opt-in sub-features are disabled by default — flip flags in `~/.config/SFFMC/extra.yaml` per feature. The standalone `memory` package now exports the MSP that wires the 4 sub-features via `mergeHooks()`.

## Sub-features

Memory composes 2 sub-features via `mergeHooks()`:

| Sub-feature | Description |
|---|---|
| `memory-core` | FTS5 SQLite index + chokidar watcher + context-recon injection (internal, in `packages/memory/src/plugin.ts`) |
| [`@sffmc/extra`](../extra/README.md) | 3 opt-in named tools: `extra_checkpoint`, `extra_judge`, `extra_dream` (disabled by default; enable per-feature in `~/.config/SFFMC/extra.yaml`) |

## Opt-in configuration

To enable @sffmc/extra features:

```yaml
# opencode.json
{
  "plugins": {
    "@sffmc/memory": {
      "extra": {
        "checkpoint": true,   // cross-turn state snapshot
        "judge": true,        // /max verdict scoring
        "dream": true         // periodic state summary
      }
    }
  }
}
```

## What it does

Gives your agent persistent memory across sessions. Indexes project docs (`memory-bank/*.md`, `AGENTS.md`, root `*.md`) into an FTS5 SQLite database and injects a structured "Context Recon" block at the start of each session. A chokidar watcher re-indexes changed files. The recon block is composed of top-importance memory rows, an `AGENTS.md` parse, and a tail of recent messages — all sized by the per-section budget.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/memory/src/index.ts"
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

20 tests across 2 files (`memory.test.ts` + `index.test.ts`).

## License

MIT
