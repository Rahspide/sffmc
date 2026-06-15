# packages/auto-max/src/

## Responsibility

Source directory for the `@sffmc/auto-max` OpenCode plugin — contains the plugin entrypoint (`index.ts`), pure coordinator logic (`coordinator.ts`), and 22 test cases (`index.test.ts`). Detects tool failure loops and injects Max Mode escalation fragments.

## Design Patterns

- **Separation of concerns** — `coordinator.ts` is a pure-data module with zero side effects (no I/O, no OpenCode hooks, no console). `index.ts` is the imperative shell: config loading, hook wiring, error classification, I/O.
- **Session-scoped state** — `Map<sessionID, SessionState>` in plugin-level `PluginState`. Lazy creation avoids pre-allocating state for inactive sessions.
- **Composite failure key** — `tool::errorType` in `failCount` Map. Different error types for the same tool count independently. `recordSuccess` deletes all matching prefixes.
- **Cost cap as session-lifetime quota** — `maxCallsThisSession` counts triggers fired. `resetSession` (called on `session.created`) clears `failCount` and `triggered` but NOT `maxCallsThisSession`, so the cap binds for the entire session.
- **One-shot trigger signaling** — `ctx._autoMaxTrigger` set in `tool.execute.after`, checked + deleted in `experimental.chat.system.transform`. Prevents duplicate fragment injection.
- **Module-level load guard** — `let loadedLogged = false` in `index.ts` ensures the `[auto-max] loaded` banner prints exactly once per process lifetime.

## Data & Control Flow

```
coordinator.ts (pure)
  ├── createSessionState() → SessionState
  ├── recordFailure(state, tool, errorType) → increments failCount[tool::errorType]
  ├── recordSuccess(state, tool) → deletes all failCount keys prefix-matching `${tool}::`
  ├── shouldTriggerMaxMode(state, tool, errorType, config) → guard chain → boolean
  ├── markTriggered(state) → triggered=true, maxCallsThisSession++
  └── resetSession(state) → failCount.clear(), triggered=false

index.ts (imperative shell)
  ├── loadConfig() → AutoMaxConfig (YAML merge with defaults)
  ├── extractErrorType(output) → string (regex on output, or object.code/name, fallback "UNKNOWN")
  ├── getOrCreateSession(state, sessionID) → SessionState
  └── server(ctx) → HookMap
        ├── config: no-op
        ├── event: session.created → resetSession
        ├── tool.execute.after: detect error → count → check trigger → set ctx._autoMaxTrigger
        └── experimental.chat.system.transform: inject fragment → delete ctx._autoMaxTrigger

index.test.ts (22 tests)
  ├── coordinator block (11): unit tests for all 7 pure functions
  └── plugin entry block (11): integration tests for hooks, trigger, fragment injection
```

## OpenCode Hooks

See parent `codemap.md` — all four hooks (`config`, `event`, `tool.execute.after`, `experimental.chat.system.transform`) live in `index.ts` `server()` return value.

## Integration Points

- **coordinator.ts → index.ts** — all 7 public functions imported and used by the shell.
- **index.ts → @sffmc/shared** — `PluginContext` type for `server(ctx)`.
- **index.ts → yaml** — `parse()` for config file.
- **index.ts → fs, path, os** — `readFileSync`, `existsSync`, `resolve`, `homedir` for config loading.
- **index.ts → OpenCode runtime** — module exports `{ id, server }` shape, the standard OpenCode plugin contract.
- **index.ts → Max Mode consumer** — sets `ctx._autoMaxTrigger` for downstream consumption; injects system prompt fragment.

## Public API

All 8 public symbols (7 functions + 2 types) are defined in `coordinator.ts` and re-exported via `index.ts`. See parent `codemap.md` Public API table for full signatures.

## Files

| Path | Lines | Purpose |
|---|---|---|
| `coordinator.ts` | 69 | Pure-data module: `AutoMaxConfig` type, `SessionState` type, 7 pure functions (create, record failure/success, check trigger, mark triggered, reset). No side effects. |
| `index.ts` | 184 | Plugin entrypoint: YAML config loading, error type extraction, hook wiring (4 hooks), session state management, one-shot fragment injection. Exports `{ id, server }`. |
| `index.test.ts` | 302 | 22 Bun test cases: 11 coordinator unit tests (state, counting, guards, cap), 11 plugin integration tests (hooks, trigger, fragment injection). Uses dynamic `import()` for hook isolation. |
