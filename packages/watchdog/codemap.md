# packages/watchdog/

## Responsibility

F1 auto-recovery plugin that detects agent tool-failure loops (3 consecutive failures of same tool + error type within rolling window), injects a system-prompt promotion fragment to guide the agent toward alternative approaches, and prepends a recovery verdict when the tool later succeeds. Provides `/max` escape-hatch command to reset all counters.

## Design Patterns

- **Failure counter (rolling window)** — `FailureCounter` class tracks `(sessionID, tool, errorType)` → count in a `Map<string, number>`, plus a `Failure[]` ring buffer capped at `rolling_window` entries (default 10).
- **Error type filter** — `error_class_filter` list (default: `fetch_429`, `playwright_timeout`, `EAGAIN`) skips legitimate retry errors so they don't increment counters.
- **Promotion fragment injection** — `buildPromotionFragment()` returns a markdown string pushed into `data.system` via `experimental.chat.system.transform`, one-shot per promotion (session removed from `promotedSessions` after injection).
- **Recovery verdict** — After a promoted tool succeeds, `buildRecoveryVerdict()` prepends `"✓ Recovered from N failed …"` to the tool output via the same `tool.execute.after` hook reference.
- **One-shot gate** — Module-level `loadedLogged` boolean gates `console.warn("[watchdog] loaded…")` to fire only once per process lifetime.

## Data & Control Flow

```
plugin load → loadConfig() → create FailureCounter → PluginState{ counter, promotedSessions: Set, recoveringTools: Map }

session.created → resetSession(sid), clear promotedSessions + recoveringTools

tool.execute.after:
  ├─ output is error? (regex ≤4096 chars OR metadata.error flag)
  │  ├─ NO → check recoveringTools for (session, tool) → if found, inject recovery verdict → recordSuccess (reset counter)
  │  └─ YES → extractErrorType(regex: ENOENT|EACCES|…|ERR_|Error:|error:)
  │            ├─ isFiltered? → return (no-op)
  │            └─ NOT filtered → recordFailure → shouldPromote? → add sid to promotedSessions, add to recoveringTools

experimental.chat.system.transform:
  └─ sid in promotedSessions? → getRecentFailures(5) → buildPromotionFragment → push to system[] → delete sid from promotedSessions (one-shot)

experimental.chat.messages.transform:
  └─ no-op (verdict injected in tool.execute.after)

command.execute.before ("/max"):
  └─ resetSession, clear promotedSessions, clear recoveringTools
```

## OpenCode Hooks

| Hook | Registered | Role |
|---|---|---|
| `config` | Yes (no-op) | Config loaded at startup, hook body is empty. |
| `event` | Yes | Resets per-session state on `session.created`. |
| `tool.execute.after` | Yes | Core logic — detects errors, records failures/successes, injects recovery verdict, triggers promotion. |
| `experimental.chat.system.transform` | Yes | Pushes one-shot promotion fragment into system prompt for promoted sessions. |
| `experimental.chat.messages.transform` | Yes | Reserved; currently no-op (verdict handled in `tool.execute.after`). |
| `command.execute.before` | Yes | `/max` escape hatch — resets all state for the session. |

## Integration Points

- **@sffmc/shared** — imports `PluginContext` interface (`{ projectRoot, config, [key: string]: unknown }`) for the plugin server function signature.
- **yaml** — `parse()` from `yaml` package v2 reads `~/.config/SFFMC/watchdog.yaml` config file.
- **Config file** — `~/.config/SFFMC/watchdog.yaml` (defaults at `config/watchdog.example.yaml`): threshold, rolling_window, promote_model, error_class_filter, log_failures.

## Public API

| Export | From | Signature |
|---|---|---|
| `FailureCounter` | `counter.ts` | `new(threshold: number, windowSize: number)` with methods: `recordFailure`, `shouldPromote`, `recordSuccess`, `getRecentFailures`, `resetSession` |
| `buildPromotionFragment` | `promote.ts` | `(tool: string, errorType: string, failCount: number, model: string) => string` |
| `buildRecoveryVerdict` | `verdict.ts` | `(tool: string, errorType: string, attempts: number) => string` |
| `WatchdogConfig` | `index.ts` (interface) | `{ threshold, rolling_window, promote_model, error_class_filter, log_failures }` |
| Plugin export | `index.ts` | `export default { id: "@sffmc/watchdog", server }` — server returns hook map for OpenCode. |
