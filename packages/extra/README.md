# @sffmc/extra

> **Part of `@sffmc/memory` composite.** This package houses 3 opt-in sub-features (checkpoint, judge, dream) used by the memory composite. Load via `@sffmc/memory` for the full set, or standalone if you only need the extra bundle. All 3 sub-features are disabled by default — flip flags in `~/.config/SFFMC/extra.yaml` per feature.



EXTRA plugin — opt-in bundle of 3 advanced features (Checkpoint, Judge, Dream). All disabled by default.

## What it does

A single plugin exposing 3 AI-callable tools, each gated behind a config flag:

1. **`extra_checkpoint`** — session snapshot and resumability. Captures tool-call history to enable resume-after-crash.
2. **`extra_judge`** — multi-candidate evaluation and ranking. Evaluates N candidate responses against an optional rubric and returns ranked scores.
3. **`extra_dream`** — background session summarization and deduplication. Periodically scans sessions, deduplicates overlapping content, archives old sessions, and generates structured summaries.

By default, **all 3 features are DISABLED**. Set flags in `~/.config/SFFMC/extra.yaml` to opt in per feature.

## Install

This plugin is part of the SFFMC monorepo. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/extra/src/index.ts"
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

Then call the tools:

```
extra_checkpoint()
extra_judge()
extra_dream()
```

When a feature is enabled but the underlying data layer returns no candidates
(e.g. no checkpoints exist, no judge candidates pending), the tool returns
`{ ok: true, skipped: true, reason: "no work pending" }`. Full snapshot,
verdict, and dream-restore operations return rich data when invoked against
populated state.

## Config

All keys in `~/.config/SFFMC/extra.yaml`:

| Key | Type | Default | Description |
|---|---|---|---|
| `checkpoint` | boolean | `false` | Enable Checkpoint tool |
| `judge` | boolean | `false` | Enable Judge tool |
| `dream` | boolean | `false` | Enable Dream tool |
| `dream_threshold` | number | `50` | Minimum sessions before dedup triggers |
| `dream_interval_hours` | number | `24` | Hours between Dream scans |

## Tests

```bash
bun test packages/extra/
```

## License

MIT
