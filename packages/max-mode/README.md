# @sffmc/max-mode

F7 Max Mode — parallel drafts plus judge selection (W3).

## What it does

For hard problems, generates N candidate responses in parallel at high temperature, then asks a judge model to pick the best one. Invoked via the `/max` slash command (with `--dry-run` for cost estimation). Uses the "schema-only tools" trick — candidate tool calls are captured but not executed during Max Mode; the user reviews them and confirms with `/max execute`. The winner message is injected into the next system/messages transform. Costs are bounded by a `budget_cap_multiplier` (default 5x a single call).

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode-sandbox/opencode.json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/max-mode/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/max-mode.yaml`:

```yaml
# F7 Max Mode — plugin config

version: 1

# Number of parallel candidate drafts (max 5)
n_candidates: 3

# Override candidate models (empty = same as primary)
candidate_models: []

# Temperature for candidate generation (higher = more creative)
candidate_temperature: 1.0

# Judge model for selecting the best candidate
judge_model: ocg/deepseek-v4-flash

# Safety cap: abort if total token cost exceeds N × single call
# 5 means abort if > 5x the cost of 1 candidate call
budget_cap_multiplier: 5

# Dry-run mode: only estimate costs, don't actually call models
dry_run: false
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Load config, log `dry_run` warning if enabled |
| `command.execute.before` | `/max` → run Max Mode; `/max execute` → restore captured tool calls; `--dry-run` → estimate only |
| `experimental.chat.system.transform` | Push the Max Mode verdict onto the system prompt (one-shot) |
| `tool.execute.before` | In schema-only mode, tag args with `_schemaOnly: true` so candidates capture calls instead of executing |
| `experimental.chat.messages.transform` | Push the Max Mode verdict onto the messages array (one-shot) |

## Tests

```bash
bun test packages/max-mode/
```

31 tests in `src/index.test.ts`.

## License

MIT
