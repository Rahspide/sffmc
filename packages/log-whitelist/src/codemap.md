# packages/log-whitelist/src/

## Responsibility

Source code for the @sffmc/log-whitelist OpenCode plugin. Contains the plugin entry point (hook registration), the core line-filtering algorithm, and Bun test suite.

## Design Patterns

- **Separation of concerns** — `filter.ts` is a pure-function filtering module with zero OpenCode dependencies; `index.ts` is the plugin glue (config loading, hook wiring, state management).
- **In-place mutation** — Hooks mutate `result.output` and `data.text` directly (OpenCode convention for `tool.execute.after` and `experimental.text.complete`).
- **Early-return guard** — `whitelist.length === 0` check at top of each hook prevents unnecessary work when disabled.
- **Regex compilation with fallback** — Invalid regex patterns silently become no-ops (`new RegExp("")` filtered out by `.source !== ""` check) rather than crashing plugin startup.

## Data & Control Flow

```
index.ts
  ─ imports filterLines, shouldKeep, shouldDrop from ./filter
  ─ imports loadConfig, PluginContext from @sffmc/shared
  ─ defines LogWhitelistConfig, defaultConfig, PluginState
  ─ server(ctx) closure:
      1. loadConfig("log-whitelist", defaultConfig) → reads YAML
      2. compilePatterns() → RegExp[] (safe, skips malformed)
      3. Returns hook object with 3 hooks
         ├─ config: no-op
         ├─ tool.execute.after: filterLines → mutate result.output
         └─ experimental.text.complete: filterLines → mutate data.text

filter.ts
  ─ Pure functions, no imports
  ├─ shouldKeep(line, whitelist)   → whitelist.some(re => re.test(line))
  ├─ shouldDrop(line, blacklist)   → blacklist.some(re => re.test(line))
  └─ filterLines(lines, wl, bl, max, marker)
       for each line:
         shouldDrop? → skip
         shouldKeep? → push (cap at maxKeptLines, append marker on overflow)
       return { kept, dropped = total - kept.length }
```

## OpenCode Hooks

Same as package-level — `config`, `tool.execute.after`, `experimental.text.complete`. Implementation detail: the `config` hook is a declared no-op because config is already loaded in `server()` closure at plugin init time.

## Integration Points

| Point | File | Dependency |
|---|---|---|
| Config loader | `index.ts:2` | `@sffmc/shared` → `loadConfig<T>()` |
| YAML parsing | transitive | `yaml` (via `@sffmc/shared`) |
| OpenCode runtime | `index.ts:115-118` | `export default { id, server }` — expected shape for `opencode.json` `plugins[]` |
| Bun test runner | `index.test.ts:1` | `bun:test` — `describe`, `it`, `expect` |

## Files

| Path | Purpose |
|---|---|
| `index.ts` | Plugin entry — hook registration (`config`, `tool.execute.after`, `experimental.text.complete`), state management, config compilation |
| `filter.ts` | Pure filtering functions — `shouldKeep`, `shouldDrop`, `filterLines`. No OpenCode dependencies. |
| `index.test.ts` | Bun test suite — 10 unit tests for filter functions + 4 integration tests for plugin exports and hook behavior |
| `codemap.md` | This file |

## Public API

Same exports as package-level, defined across two modules:

- `index.ts`: `default` (plugin object), `LogWhitelistConfig`
- `filter.ts`: `FilterResult`, `shouldKeep()`, `shouldDrop()`, `filterLines()`
