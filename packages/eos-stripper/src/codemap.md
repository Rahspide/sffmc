# packages/eos-stripper/src/

## Responsibility

Core implementation of the EOS stripper: pure text-mutation functions (`stripEos`, `looksLikeEosOnly`), default pattern constants, and the OpenCode plugin entry point (`server` function) that wires config loading and hook registration.

## Design Patterns

- **Pure functions** — `stripEos` and `looksLikeEosOnly` are stateless, no I/O, no side effects. Easy to test in isolation (12 of 17 tests are unit tests on these functions).
- **End-only pattern matching** — uses `String.endsWith()` exclusively. No substring search, no regex. Prevents false positives when EOS tokens appear in instructional text.
- **Two-pass strip loop** — outer `while(changed)` loop runs until no more patterns match. Inner passes: (1) exact `endsWith`, (2) `trimEnd` then `endsWith` (handles whitespace-padded EOS). Each iteration strips at most one pattern, then restarts.
- **In-place mutation** — `experimental.text.complete` hook mutates `data.text` directly. No return value. This is the standard OpenCode hook contract for text transforms.
- **Config fallback** — `config.patterns.length > 0 ? config.patterns : DEFAULT_EOS_PATTERNS`. Empty user config means "use defaults."

## Data & Control Flow

```
index.ts (plugin entry)
  └─ server(ctx) → loadConfig → patterns → state
       └─ returns { config, experimental.text.complete }
            │
            ├─ config hook: no-op (config already loaded)
            │
            └─ experimental.text.complete hook:
                 ├─ looksLikeEosOnly(data.text, patterns) → true?  data.text = ""
                 └─ false?  stripEos(data.text, patterns) → mutate data.text

patterns.ts (pure logic, no I/O)
  └─ stripEos(text, patterns) → string
       └─ while(changed): endsWith → trimEnd+endsWith → loop
  └─ looksLikeEosOnly(text, patterns) → boolean
       └─ replaceAll each pattern → trim → check empty
  └─ DEFAULT_EOS_PATTERNS → string[] (constant)
```

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Plugin entry point. Defines `EosConfig`, `PluginState`, `server()` function that registers `config` and `experimental.text.complete` hooks. Exports `default { id, server }`. |
| `src/patterns.ts` | Pure text-mutation logic. Exports `stripEos` (end-only pattern strip with iterative loop), `looksLikeEosOnly` (EOS-only detection), and `DEFAULT_EOS_PATTERNS` (10 common EOS tokens). No I/O, no side effects. |
| `src/index.test.ts` | 17 tests in 3 suites. `stripEos` (9): end strip, multi-pattern, mid-text preservation, whitespace-padded, empty string, pure-EOS, specific tokens, custom patterns. `looksLikeEosOnly` (4): true, whitespace, false mixed, false empty. `Plugin entry` (4): export shape, hooks returned, end strip via hook, EOS-only drop via hook. |

## OpenCode Hooks

| Hook | Source | Purpose |
|---|---|---|
| `config` | `index.ts:33` | No-op stub — config loaded in `server()` body before hooks are returned |
| `experimental.text.complete` | `index.ts:37` | Core logic: check EOS-only → drop, else strip end → mutate `data.text` |

## Integration Points

| Point | Source | Role |
|---|---|---|
| `import { loadConfig, PluginContext } from "@sffmc/shared"` | `index.ts:2` | YAML config loader, context type for `server(ctx)` |
| `import { stripEos, looksLikeEosOnly, DEFAULT_EOS_PATTERNS } from "./patterns"` | `index.ts:1` | Internal dependency — pure functions and constants |
| `export default { id: "@sffmc/eos-stripper", server }` | `index.ts:63-66` | Plugin export consumed by OpenCode plugin loader |

## Public API

| Export | Source | Signature |
|---|---|---|
| `stripEos` | `patterns.ts:18` | `(text: string, patterns: string[]) => string` |
| `looksLikeEosOnly` | `patterns.ts:49` | `(text: string, patterns: string[]) => boolean` |
| `DEFAULT_EOS_PATTERNS` | `patterns.ts:1` | `string[]` (10 elements) |
| `EosConfig` | `index.ts:4` | `{ patterns: string[], strip_from_end_only: boolean, log_stripped_count: boolean }` |
| `default` (plugin) | `index.ts:63` | `{ id: string, server: (ctx: PluginContext) => Promise<object> }` |
