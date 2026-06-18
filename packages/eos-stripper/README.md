# @sffmc/eos-stripper

> **Part of `@sffmc/safety` composite.** This package is a sub-feature of the safety bundle. Load via `@sffmc/safety` for the full set (eos-stripper + watchdog + rules + auto-max + log-whitelist), or standalone if you only need eos-stripper.



EOS token stripper — removes End-of-Sequence tokens from assistant text (W2).

## What it does

Local models (Ollama, llama.cpp, vLLM) commonly emit EOS tokens such as `</s>`, `<|endoftext|>`, `<|im_end|>` in the middle of responses. These confuse downstream tools and pollute the UI. This plugin hooks the `experimental.text.complete` event and strips configured patterns; if a text part becomes nothing but EOS tokens, it is emptied entirely. Runs *before* `log-whitelist` so its output is still readable before filtering.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/eos-stripper/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/eos.yaml`:

```yaml
patterns:                        # leave empty to use DEFAULT_EOS_PATTERNS
  - '</s>'
  - '<|endoftext|>'
  - '<|im_end|>'
  - '<|eot_id|>'
strip_from_end_only: true        # safety: don't strip from middle (might be intentional)
log_stripped_count: true
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Load config, pick user patterns or fall back to `DEFAULT_EOS_PATTERNS` |
| `experimental.text.complete` | Strip configured EOS patterns from the end of text parts; drop EOS-only parts entirely |

## Tests

```bash
bun test packages/eos-stripper/
```

17 tests in `src/index.test.ts`.

## License

MIT
