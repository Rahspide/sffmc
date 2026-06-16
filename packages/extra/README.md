# @sffmc/extra

> **Part of `@sffmc/memory` MSP.** This package houses 3 opt-in sub-features (checkpoint, judge, dream) used by the memory MSP. Load via `@sffmc/memory` for the full set, or standalone if you only need the extra bundle. All 3 sub-features are disabled by default — flip flags in `~/.config/SFFMC/extra.yaml` per feature.



EXTRA plugin — opt-in bundle of 3 advanced features (F5' Checkpoint, F6' Judge, F8 Dream). All disabled by default.

## What it does

A single plugin exposing 3 LLM-callable tools, each gated behind a config flag:

1. **`extra_checkpoint`** (F5') — session snapshot and resumability. Captures tool-call history to enable resume-after-crash. (Phase 3)
2. **`extra_judge`** (F6') — multi-candidate evaluation and ranking. Evaluates N candidate responses against an optional rubric and returns ranked scores. (Phase 2)
3. **`extra_dream`** (F8) — background session summarization and deduplication. Periodically scans sessions, deduplicates overlapping content, archives old sessions, and generates structured summaries. (Phase 4)

By default, **all 3 features are DISABLED**. Set flags in `~/.config/SFFMC/extra.yaml` to opt in per feature.

## Install

This plugin is part of the SFFMC monorepo. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/extra/src/index.ts"
  ]
}
```

## Usage

### Enable features

Create `~/.config/SFFMC/extra.yaml`:

```yaml
# Enable individual features
checkpoint: true
judge: false
dream: false

# Dream-specific options (only used when dream is enabled)
dream_threshold: 50
dream_interval_hours: 24
```

Then call the tools from an LLM:

```
extra_checkpoint()
extra_judge()
extra_dream()
```

When a feature is disabled, its tool returns `{ ok: true, skipped: true, reason: "feature disabled" }`. When enabled but not yet implemented (current state), it returns `{ ok: true, status: "stub" }`.

## Config

All keys in `~/.config/SFFMC/extra.yaml`:

| Key | Type | Default | Description |
|---|---|---|---|
| `checkpoint` | boolean | `false` | Enable F5' Checkpoint tool |
| `judge` | boolean | `false` | Enable F6' Judge tool |
| `dream` | boolean | `false` | Enable F8 Dream tool |
| `dream_threshold` | number | `50` | Minimum sessions before dedup triggers |
| `dream_interval_hours` | number | `24` | Hours between Dream scans |

## Tests

```bash
bun test packages/extra/
```

## License

MIT
