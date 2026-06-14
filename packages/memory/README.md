# F4' Memory — Persistent Agent Memory with Context Recon 8K

Gives your agent persistent memory across sessions. Indexes project docs (`memory-bank/*.md`, `AGENTS.md`, root `*.md`) into an FTS5 SQLite database and injects a structured 8K-token "Context Recon" block at the start of each session.

## Install

Copy the example config and edit as needed:

```bash
mkdir -p ~/.config/SFFMC
cp config/memory.example.yaml ~/.config/SFFMC/memory.yaml
```

Then add to your OpenCode plugins:

```json
{
  "plugins": [
    {
      "id": "@sffmc/memory",
      "path": "/path/to/SFFMC/packages/memory/src/index.ts"
    }
  ]
}
```

## How it works

| Hook | Purpose |
|------|---------|
| `config` | Initializes SQLite DB (WAL mode), starts file watcher |
| `event` (`session.created`) | Flags that recon injection is needed |
| `experimental.chat.messages.transform` | Injects Context Recon 8K as first system message (once per session) |

## Token cost

- **Per turn**: 0 tokens — injection fires once at session start
- **Session start**: ~8K tokens (1.5K memory + 1.5K checkpoint + 1K task tree + 2K recent context + 2K AGENTS.md)

## Config (`~/.config/SFFMC/memory.yaml`)

```yaml
storage_path: ~/.local/share/SFFMC/memory/index.sqlite
recon_budgets:
  memory: 6144        # 1.5K tokens ≈ 6144 chars
  checkpoint: 6144    # 1.5K tokens
  task_tree: 4096     # 1K tokens
  tail: 8192          # 2K tokens
  agents: 8192        # 2K tokens
memory_paths:
  - memory-bank/
  - AGENTS.md
  - "*.md"
default_importance: 0.5
```

## License

MIT
