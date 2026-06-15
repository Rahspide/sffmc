# packages/rules/

## Responsibility

Safety net plugin (F2) that evaluates every tool call against user-defined YAML rules before execution — blocks destructive operations, warns on risky ones, and enters panic mode on config parse failure.

## Design Patterns

- **YAML gate-based allow/deny** — Rules defined declaratively as a `rules:` array. Each rule has `match` conditions (`tool`, `command_match`, `path_outside`) and an `action` (`allow`, `deny`, `ask`). First matching rule wins.
- **Panic mode** — Module-level `panicMode` boolean. If the YAML file is unparseable or structurally invalid, panic mode engages and *all* tool calls are denied with an error message pointing to the broken config.
- **Polling hot-reload watcher** — `watchRules()` polls the YAML file every 1s via `setInterval` + `statSync().mtimeMs`. On change, re-parses and atomically swaps the in-memory rule set. No external watcher dependency (despite README mentioning chokidar — implementation uses bare `fs` polling).
- **Default rules fallback** — If `~/.config/SFFMC/rules.yaml` is missing, the plugin seeds a hardcoded default rule set (all read tools allowed, path-outside-project denied, destructive bash patterns denied/asked).

## Data & Control Flow

```
server(ctx)
  ├─ loadRules(configPath)         // read YAML → parse → validate → Rules
  │   ├─ file missing → seed DEFAULT_RULES_YAML
  │   └─ parse error → panicMode=true, return empty rules
  ├─ watchRules(configPath, cb)    // setInterval 1s polling, cb swaps state.rules
  └─ return hooks object
       ├─ tool.execute.before → isPanicMode? → throw
       │                       → evaluate(rules, tool, args, projectRoot)
       │                       → deny → throw Error
       │                       → ask → console.warn
       └─ permission.ask → isPanicMode? → status.status="deny"
                         → evaluate(rules, tool, args, projectRoot)
                         → deny → status.status="deny"
```

### Gate evaluation flow (per call)

```
evaluate(rules, toolName, args, projectRoot)
  for each rule in rules.rules:
    rule.match.tool !== toolName → skip
    rule.match.command_match? → build RegExp, test args.command → match/continue
    rule.match.path_outside? → extractPaths(args), isInside() check → match/continue
    no extra condition → match (exact tool-name-only rule)
  fallthrough → { action: "allow", reason: "no matching rule" }
```

### Panic mode trigger

- `parseRules()` throws → `panicMode = true` → auto-cleared on next successful parse
- `loadRules()` catches parse error → `panicMode = true`
- `watchRules()` tick catches parse error → `panicMode = true`
- Recovery: next successful `parseRules()` or `watchRules()` tick sets `panicMode = false`

## OpenCode Hooks

| Hook | Behavior |
|---|---|
| `tool.execute.before` | Throws `Error` on `deny` (blocks execution). `console.warn`s on `ask` (lets execution proceed with warning). No-op on `allow`. |
| `permission.ask` | Sets `status.status = "deny"` when rule evaluation returns `deny`. No-op on `allow`/`ask`. |

Both hooks check `isPanicMode()` before evaluation — panic mode denies all.

## Integration Points

- **@sffmc/shared** — `PluginContext` type (provides `projectRoot`, `config`)
- **yaml** (`^2.0.0`) — YAML parsing via `parse()` from the `yaml` npm package
- **node:fs** — `readFileSync`, `existsSync`, `statSync`, `writeFileSync` (tests), `unlinkSync` (tests)
- **node:path** — `resolve`
- **node:os** — `homedir`
- Config file: `~/.config/SFFMC/rules.yaml` (hardcoded path via `resolve(homedir(), ".config/SFFMC/rules.yaml")`)

## Public API

Exported from `index.ts` (re-exports from `rules.ts` + `gate.ts`):

| Symbol | Source | Description |
|---|---|---|
| `evaluate` | gate.ts | Core gate: match tool+args against rules, return `{ action, reason }` |
| `loadRules` | rules.ts | Read and parse rules YAML file, returns `Rules` object |
| `watchRules` | rules.ts | Start 1s polling watcher, returns `{ stop }` handle |
| `parseRules` | rules.ts | Parse YAML string into validated `Rules`, throws on invalid |
| `isPanicMode` | rules.ts | Query module-level panic state |
| `Rules` (type) | rules.ts | `{ version: number; rules: Rule[] }` |
| default export | index.ts | OpenCode plugin: `{ id: "@sffmc/rules", server }` |
