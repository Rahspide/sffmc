# packages/watchdog/src/

## Responsibility

Source implementation of F1 watchdog: failure counter with rolling window, error-type extraction and filtering, system-prompt promotion fragment generation, and recovery verdict injection. Plugin entry at `index.ts` wires all hooks to OpenCode's plugin runtime via `@sffmc/shared/PluginContext`.

## Design Patterns

- **Failure counter (rolling window)** — `FailureCounter` class uses `Map<"session::tool::errorType", count>` for precision counting plus `Failure[]` array trimmed to `windowSize` for context retrieval.
- **Error type filter** — `isFiltered()` case-insensitive substring match against `error_class_filter` list; filtered errors (rate limits, timeouts, EAGAIN) skip counting.
- **Promotion fragment injection** — `buildPromotionFragment()` returns a markdown-formatted instruction string pushed into `data.system[]` via `experimental.chat.system.transform`, one-shot (session removed from `promotedSessions` Set after first injection).
- **Recovery verdict** — `buildRecoveryVerdict()` prepends `"✓ Recovered from N failed …"` to `result.output` string in `tool.execute.after`, detected by checking `recoveringTools` Map keyed by `"sessionID::tool"`.
- **One-shot gate** — Module-level `loadedLogged` boolean in `index.ts` gates `console.warn("[watchdog] loaded…")` to fire only once per process lifetime, preventing log spam on hot-reload.

## Data & Control Flow

```
index.ts: server(ctx) →
  loadConfig()            → watchdog.yaml or defaultConfig
  new FailureCounter(3,10)
  PluginState{ counter, promotedSessions: Set, recoveringTools: Map<"sid::tool", {errorType, attempts}> }

event("session.created"):
  counter.resetSession(sid)     → deletes all Map entries with sid prefix, filters recent[]
  promotedSessions.delete(sid)
  recoveringTools.clear()

tool.execute.after(toolCtx, result):
  detect error: regex check (≤4096 chars, /^Error:|\bERR_|ENOENT|…|throw\s+new\s+Error/i) OR metadata.error non-null
  ├─ NOT error →
  │    check recoveringTools.get("sid::tool") → if found, prepend buildRecoveryVerdict() to result.output
  │    counter.recordSuccess(tool, sid) → deletes all "sid::tool::*" Map entries
  └─ IS error →
       errorType = extractErrorType(output) → regex-first token (ENOENT|EACCES|…|Error:|error:) or "UNKNOWN"
       isFiltered(errorType, config.error_class_filter) → return (skip)
       counter.recordFailure(tool, errorType, sid) → increment Map, push Failure to recent[], trim window
       counter.shouldPromote(tool, errorType, sid) → count ≥ threshold?
       └─ YES → promotedSessions.add(sid), recoveringTools.set("sid::tool", {errorType, attempts: threshold})

experimental.chat.system.transform(_input, data):
  sid in promotedSessions? → getRecentFailures(sid, 5) → buildPromotionFragment(last.tool, last.errorType, threshold, model)
  data.system.push(fragment)
  promotedSessions.delete(sid)  ← one-shot

experimental.chat.messages.transform:
  no-op (recovery verdict injected in tool.execute.after)

command.execute.before({command:"/max"}):
  counter.resetSession(sid), promotedSessions.delete(sid), recoveringTools.clear()
```

## OpenCode Hooks

| Hook | Registered | Role |
|---|---|---|
| `config` | Yes (no-op) | Returns empty async function; config loaded eagerly at plugin init. |
| `event` | Yes | `session.created` → full state reset for that session ID. |
| `tool.execute.after` | Yes | Core error detection, failure counting, promotion trigger, recovery verdict injection. |
| `experimental.chat.system.transform` | Yes | One-shot promotion fragment injection into system prompt. |
| `experimental.chat.messages.transform` | Yes | No-op; verdict injection happens in `tool.execute.after` (direct `result.output` mutation). |
| `command.execute.before` | Yes | `/max` escape hatch: resets counters, promoted state, recovering state for the session. |

## Integration Points

- **@sffmc/shared** — `PluginContext` (`{ projectRoot, config, [key: string]: unknown }`) used as server parameter type.
- **yaml** — `parse()` for reading `~/.config/SFFMC/watchdog.yaml` (YAML v2).
- **Node built-ins** — `fs.readFileSync`, `fs.existsSync`, `path.resolve`, `os.homedir` for config file loading.
- **Config defaults** — `config/watchdog.example.yaml` documents the schema; `defaultConfig` constant in `index.ts` provides fallback values.

## Public API

| Export | From | Signature |
|---|---|---|
| `FailureCounter` | `counter.ts` | `new(threshold: number, windowSize: number)` — methods: `recordFailure`, `shouldPromote`, `recordSuccess`, `getRecentFailures`, `resetSession` |
| `buildPromotionFragment` | `promote.ts` | `(tool, errorType, failCount, model) => string` |
| `buildRecoveryVerdict` | `verdict.ts` | `(tool, errorType, attempts) => string` |
| `WatchdogConfig` | `index.ts` (interface) | `{ threshold, rolling_window, promote_model, error_class_filter, log_failures }` |
| Plugin default export | `index.ts` | `{ id: "@sffmc/watchdog", server }` — server returns hook map. |

## Files

| Path | Purpose |
|---|---|
| `src/index.ts` | Plugin entry point — config loading, session state management, all 6 hook registrations, error detection regex, `loadedLogged` gate, `extractErrorType`/`isFiltered` helpers. |
| `src/counter.ts` | `FailureCounter` class — Map-based per-`(session, tool, errorType)` failure counts, rolling `Failure[]` window, `shouldPromote` threshold check, `recordSuccess` blanket reset, `resetSession` full cleanup. `Failure` interface exported. |
| `src/promote.ts` | `buildPromotionFragment()` — builds the markdown system-prompt fragment injected on promotion (STUCK DETECTED + DETAILED THINKING instructions + model name). |
| `src/verdict.ts` | `buildRecoveryVerdict()` — builds the one-line recovery message prepended to successful tool output after a prior promotion. |
| `src/index.test.ts` | 13 test cases (Bun test runner): `FailureCounter` (7 tests: threshold trigger, success reset, session isolation, error-type isolation, recent-failures limit, session reset, rolling window trim), `buildPromotionFragment` (2 tests), `buildRecoveryVerdict` (1 test), plugin entry (4 tests: exports, hook presence, /max escape hatch, filtered errors), false-positive prevention (5 tests: markdown content, real errors, long-output skip, throw pattern, bare "fail" word). |
