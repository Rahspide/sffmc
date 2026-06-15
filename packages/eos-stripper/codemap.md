# packages/eos-stripper/

## Responsibility

Strips End-of-Sequence tokens (`</s>`, `<|im_end|>`, etc.) emitted by local models (Ollama, llama.cpp, vLLM) from assistant text at render time. Hooks `experimental.text.complete` to mutate `data.text` before the UI or downstream plugins see it.

## Design Patterns

- **End-only safety** — `stripEos` uses `String.endsWith()`, never regex or substring. EOS tokens in the middle of text are preserved because local models sometimes emit them intentionally in instruction templates.
- **EOS-only detection** — `looksLikeEosOnly` checks whether a text part is entirely EOS tokens + whitespace. If true, the entire part is emptied (`data.text = ""`), preventing blank lines or lone whitespace from appearing in the UI.
- **Iterative strip loop** — `stripEos` runs a `while (changed)` loop that strips one trailing pattern per iteration, plus a whitespace-aware pass (`trimEnd` then `endsWith`). Handles chained patterns like `</s><|im_end|>` and whitespace-padded patterns like `  </s>`.
- **Config fallback chain** — user YAML → empty patterns array → `DEFAULT_EOS_PATTERNS`. Users get sensible defaults without configuration.
- **Plugin module shape** — `export default { id, server }` — standard OpenCode plugin convention, loaded via `file://` path.

## Data & Control Flow

```
config hook fires (startup)
  → loadConfig<EosConfig>("eos-stripper", defaultConfig)  // reads ~/.config/SFFMC/eos.yaml
  → patterns = config.patterns.length > 0 ? config.patterns : DEFAULT_EOS_PATTERNS
  → state = { config, patterns, strippedCount: 0 }

experimental.text.complete hook fires (every assistant text part)
  → if looksLikeEosOnly(data.text, state.patterns):
       data.text = ""           // drop entire part
       strippedCount++
       optional log
  → else:
       original = data.text
       data.text = stripEos(data.text, state.patterns)  // mutate in-place
       if changed:
         strippedCount++
         optional log
```

## OpenCode Hooks

| Hook | When | Purpose |
|---|---|---|
| `config` | Plugin init | Load YAML config, resolve patterns (user or default) |
| `experimental.text.complete` | Every assistant text part rendered | Strip EOS from end, drop EOS-only parts |

## Integration Points

| Point | Module | Role |
|---|---|---|
| `loadConfig`, `PluginContext` | `@sffmc/shared` | YAML config loader, context type for `server(ctx)` |
| `yaml` (dep) | npm `yaml` | Parse `~/.config/SFFMC/eos.yaml` (transitive via shared) |
| Config file | `~/.config/SFFMC/eos.yaml` | User overrides: `patterns`, `strip_from_end_only`, `log_stripped_count` |
| Plugin registry | `opencode.json` `plugin[]` | Loaded via `file://` path in OpenCode config |

## Public API

| Export | Kind | Description |
|---|---|---|
| `stripEos(text, patterns)` | Function | Strip EOS patterns from **end only** of `text`. Returns stripped string. Pure, stateless. |
| `looksLikeEosOnly(text, patterns)` | Function | Returns `true` if `text` consists entirely of EOS tokens + whitespace. Pure. |
| `DEFAULT_EOS_PATTERNS` | `string[]` | 10 common EOS tokens: `</s>`, `<\|endoftext\|>`, `<\|im_end\|>`, `<\|eot_id\|>`, `<\|end\|>`, `<\|end_of_turn\|>`, `<\|endofmessage\|>`, `<\|return\|>`, `[/INST]`, `<end_of_utterance>` |
| `EosConfig` | Interface | `{ patterns: string[], strip_from_end_only: boolean, log_stripped_count: boolean }` |
| `default` | Plugin export | `{ id: "@sffmc/eos-stripper", server }` — OpenCode plugin entry |

## Package Metadata

- **Name**: `@sffmc/eos-stripper`
- **Version**: `0.1.0`
- **Type**: ES module (`"type": "module"`)
- **Entry**: `src/index.ts`
- **Deps**: `@sffmc/shared` (workspace), `yaml` ^2.0.0
- **Tests**: 17 (bun test), 3 suites: `stripEos` (9), `looksLikeEosOnly` (4), `Plugin entry` (4)
