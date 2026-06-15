# packages/rules/src/

## Responsibility

Implementation source for the F2 rules plugin — rule loading/parsing/validation (`rules.ts`), gate evaluation engine (`gate.ts`), and OpenCode plugin entry point with hook registration (`index.ts`).

## Design Patterns

- **Module-level singleton state** — `panicMode` is a module-scoped `let` boolean in `rules.ts`. No class, no DI — accessed directly by `isPanicMode()` across the module boundary.
- **First-match gate** — `evaluate()` iterates `rules.rules` array in order, returns on the first matching rule. Rule ordering matters. A broad allow-rule before a narrow deny-rule defeats the deny.
- **Regex command matching** — `command_match` strings are compiled into `RegExp` at evaluation time (not cached). Case-sensitive by default. Partial substring match unless anchored with `^`/`$`.
- **Path containment via prefix check** — `isInside()` uses `startsWith(projectRoot)` after normalizing backslashes. Relative paths (no leading `/`) always treated as inside.
- **Polling-based file watch** — No chokidar/fs.watch dependency. Uses `setInterval(1000)` + `statSync().mtimeMs` comparison. Simple, cross-platform, no native binding issues.

## Data & Control Flow

```
index.ts (server)
  │
  ├── loadRules(path)                     [rules.ts]
  │   ├── existsSync? → readFileSync → parseRules(yaml)
  │   └── not exists → { version:1, rules:[] }
  │
  ├── parseRules(yaml)                    [rules.ts]
  │   ├── yaml.parse(raw)
  │   ├── validate: rules array exists
  │   ├── validate: each rule has match.tool string
  │   ├── validate: action ∈ {allow, deny, ask}
  │   ├── success → panicMode=false, return Rules
  │   └── failure → panicMode=true, throw
  │
  ├── watchRules(path, onChange)          [rules.ts]
  │   └── setInterval 1000ms
  │       ├── statSync.mtimeMs > lastMtime?
  │       ├── loadRules(path) → panicMode=false → onChange(rules)
  │       └── catch → panicMode=true → onChange(empty rules)
  │
  └── [on each hook invocation]
      evaluate(rules, toolName, args, projectRoot)   [gate.ts]
        ├── for each rule:
        │   ├── tool match? no → next
        │   ├── command_match? → RegExp.test(args.command)
        │   ├── path_outside? → extractPaths() → isInside()
        │   └── no extra condition → match
        └── fallthrough → { action:"allow" }
```

## Files

| Path | Purpose |
|---|---|
| `index.ts` | OpenCode plugin entry point. Loads rules, starts watcher, returns `tool.execute.before` and `permission.ask` hooks. Contains hardcoded `DEFAULT_RULES_YAML` constant. |
| `gate.ts` | Rule evaluation engine. Exports `evaluate()` — iterates rules, applies `command_match` (regex) and `path_outside` (prefix) conditions, returns `{ action, reason }`. Internal helpers: `extractPaths`, `isInside`. |
| `rules.ts` | Rules lifecycle: type definitions (`Rules`, `Rule`, `RuleMatch`, `Action`), YAML parsing + validation (`parseRules`), file loading (`loadRules`), 1s polling watcher (`watchRules`), panic mode state (`isPanicMode`). |
| `index.test.ts` | 21 bun test cases covering: YAML parse validation (5), gate evaluation for bash commands (7), path_outside checks (3), file loading (2), plugin entry shape (2). Uses temp file at `/tmp/sffmc-rules-test.yaml`. |

## OpenCode Hooks

Both registered in `index.ts` server return value:

| Hook | Handler |
|---|---|
| `tool.execute.before` | Async function receiving `{ tool, sessionID, callID }` + `{ args }`. Panic mode → throw. Deny → throw. Ask → console.warn. |
| `permission.ask` | Async function receiving `{ tool?, name?, args? }` + `{ status }`. Panic mode → `status="deny"`. Deny → `status="deny"`. |

## Integration Points

| Dependency | Used in | Purpose |
|---|---|---|
| `@sffmc/shared` | index.ts | `PluginContext` type for `server()` parameter |
| `yaml` | rules.ts | `parse()` for YAML → object deserialization |
| `node:fs` | rules.ts, index.ts | `readFileSync`, `existsSync`, `statSync` (rules loading/watching) |
| `node:path` | index.ts | `resolve` for config path construction |
| `node:os` | index.ts | `homedir` for config path base |

## Public API

| Export | Kind | Source | Description |
|---|---|---|---|
| `evaluate` | function | gate.ts | `(rules, toolName, args, projectRoot) → { action: Action, reason: string }` |
| `loadRules` | function | rules.ts | `(path: string) → Rules` — read + parse file, panic on error |
| `watchRules` | function | rules.ts | `(path, onChange) → { stop }` — 1s polling watcher |
| `parseRules` | function | rules.ts | `(yaml: string) → Rules` — parse + validate, throw on invalid |
| `isPanicMode` | function | rules.ts | `() → boolean` — current panic state |
| `Rules` | type | rules.ts | `{ version: number; rules: Rule[] }` |
| `Rule` | type | rules.ts | `{ match: RuleMatch; action: Action }` |
| `RuleMatch` | type | rules.ts | `{ tool: string; command_match?: string; path_outside?: string }` |
| `Action` | type | rules.ts | `"allow" \| "deny" \| "ask"` |
| default | object | index.ts | `{ id: "@sffmc/rules", server: (ctx) => hooks }` |
