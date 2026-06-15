# packages/log-whitelist/

## Responsibility

Filters verbose tool output and chat text to keep only lines matching a configurable regex whitelist, with a blacklist override. Reduces token noise by 5–15% in chatty outputs (build logs, test runners).

## Design Patterns

- **Whitelist/blacklist filter** — Lines kept if they match at least one whitelist pattern AND do not match any blacklist pattern. Blacklist takes priority.
- **Run-order aware** — Registered on `experimental.text.complete` to run *after* `eos-stripper` in the text-complete chain (normal plugin load order is sufficient; no explicit ordering mechanism).
- **EOS cleanup** — No EOS markers in output; the plugin only filters lines, it does not generate markers that need cleanup.
- **Stateless hook design** — Compiled regexes are computed once at `config` hook (startup). Hooks mutate result objects in-place (`result.output`, `data.text`).
- **Graceful degradation** — Empty whitelist → no-op. Non-string output → pass-through. Malformed regex patterns → replaced with empty `(?:)` matcher.

## Data & Control Flow

```
Startup:
  server() called
    → loadConfig<LogWhitelistConfig>("log-whitelist", defaultConfig)  // reads ~/.config/SFFMC/log.yaml
    → compilePatterns(whitelist) → RegExp[]
    → compilePatterns(blacklist) → RegExp[]
    → state frozen (regexes immutable for session lifetime)

Per tool execution:
  tool.execute.after fires
    → if whitelist empty: return (no-op)
    → if output not string: return (pass-through)
    → output.split("\n")
    → filterLines(lines, whitelist, blacklist, maxKeptLines, truncateMarker)
      → for each line: shouldDrop? skip : shouldKeep? push : skip
      → cap at maxKeptLines, append truncation marker on overflow
    → if dropped > 0: result.output = kept.join("\n"), log to console.warn

Per chat text completion:
  experimental.text.complete fires (after eos-stripper)
    → same filterLines pipeline on data.text
    → if dropped > 0: data.text = kept.join("\n"), log to console.warn
```

## OpenCode Hooks

| Hook | When | Action |
|---|---|---|
| `config` | Plugin load | No-op (config loaded in `server()` closure) |
| `tool.execute.after` | After each tool call | Filter `result.output` string, rewrites in-place |
| `experimental.text.complete` | After text completion | Filter `data.text` string, rewrites in-place |

## Integration Points

| Point | Dependency | Purpose |
|---|---|---|
| `@sffmc/shared` | Workspace | `loadConfig<T>(section, defaults)` for YAML config loading; `PluginContext` type |
| `yaml` | npm `^2.0.0` | Transitive dependency of `@sffmc/shared` for `log.yaml` parsing |
| `~/.config/SFFMC/log.yaml` | Filesystem | Runtime configuration (whitelist, blacklist, thresholds) |
| OpenCode plugin system | Runtime | Registered via `opencode.json` `plugins[]`, receives hook contexts |

## Public API

| Export | Kind | Signature |
|---|---|---|
| `default` | Plugin object | `{ id: "@sffmc/log-whitelist", server: (ctx: PluginContext) => Promise<Hooks> }` |
| `LogWhitelistConfig` | Interface | `{ whitelist: string[]; blacklist: string[]; max_kept_lines: number; truncate_marker: string; log_filtered_count: boolean }` |
| `filterLines` | Function (from `./filter`) | `(lines: string[], whitelist: RegExp[], blacklist: RegExp[], maxKeptLines: number, truncateMarker: string) => FilterResult` |
| `shouldKeep` | Function (from `./filter`) | `(line: string, whitelist: RegExp[]) => boolean` |
| `shouldDrop` | Function (from `./filter`) | `(line: string, blacklist: RegExp[]) => boolean` |
