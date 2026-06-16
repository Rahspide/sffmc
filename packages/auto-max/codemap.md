# packages/auto-max/

## Responsibility

F1+F2 auto-call F7 — detects tool failure loops (same-tool:same-error N consecutive times) and injects a Max Mode escalation fragment into the system prompt to break the agent out of stuck tool calls. 100% pure TypeScript, zero dependencies beyond the SFFMC monorepo.

## Design Patterns

- **Session-scoped state** — one `SessionState` (failCount Map, triggered flag, maxCallsThisSession counter) per OpenCode session ID, held in a `Map<string, SessionState>` on the plugin's `PluginState`. Lazy-created via `getOrCreateSession`.
- **Watchdog-driven trigger** — hooks `tool.execute.after` (the watchdog's domain). Error detection uses dual signal: string regex (`error|fail|ERR_|ENOENT|...`) on output + truthiness check on `metadata.error`. Success resets all same-tool counters regardless of error type.
- **Composite failure key** — `tool::errorType` (e.g. `bash::ENOENT`). Different error types for the same tool count separately. A success on any call of that tool clears all keys starting with `tool::`.
- **Cost cap gate** — `maxCallsThisSession` (never reset, unlike `triggered`) counts how many times Max Mode fired this session. Blocks further triggers when `>= cost_cap_per_session` (default 1). `resetSession` only clears `failCount` + `triggered`; the cost cap is permanent per session.
- **Escalation fragment injection** — stores trigger info on `ctx._autoMaxTrigger` (mutable shared object). The `experimental.chat.system.transform` hook checks for this one-shot flag, appends the AUTO-MAX fragment, and deletes the flag. The fragment is plain text pushed into `data.system[]`.
- **One-shot load log** — `loadedLogged` module-level boolean gates the `[auto-max] loaded` console.warn to fire exactly once per process (plugin lifecycle).

## Data & Control Flow

```
config loaded (startup or reload)
  → loadConfig() reads ~/.config/SFFMC/auto-max.yaml
  → defaults merged: enabled, watchdog_threshold=3, cost_cap_per_session=1

session.created event
  → resetSession(getOrCreateSession(state, sid))
  → clears failCount map, resets triggered flag
  → maxCallsThisSession preserved (cost cap is session-lifetime)

tool.execute.after (every tool call)
  → if disabled: early return
  → detect error: output string regex OR metadata.error truthy
  → getOrCreateSession(state, sessionID)

  BRANCH A — no error detected:
    → recordSuccess(session, tool)
    → clears ALL failCount keys starting with `${tool}::`
    → return

  BRANCH B — error detected:
    → extractErrorType(output) → known code / "UNKNOWN"
    → recordFailure(session, tool, errorType)
    → shouldTriggerMaxMode(session, tool, errorType, config)
      → 4 guards: enabled, !triggered, under cap, counter >= threshold
    → if YES:
      → markTriggered(session) — triggered=true, maxCallsThisSession++
      → push to triggeredLog (memory-only audit trail)
      → set ctx._autoMaxTrigger = {tool, errorType, failCount, sessionID, maxConfig}
      → console.warn trigger message

  NEXT SYSTEM TRANSFORM (next user message or agent turn):
    → experimental.chat.system.transform checks ctx._autoMaxTrigger
    → if set: pushes AUTO-MAX TRIGGERED fragment into data.system[]
    → deletes ctx._autoMaxTrigger (one-shot)
    → Max Mode reads this fragment in the next prompt
```

## OpenCode Hooks

| Hook | Lifecycle | Role |
|---|---|---|
| `config` | Plugin init | No-op — config loaded from YAML at `server()` call time |
| `event` | `session.created` | Resets failCount + triggered for the new session |
| `tool.execute.after` | After every tool run | Primary logic: error detection, counting, trigger decision |
| `experimental.chat.system.transform` | Before each chat turn | Injects AUTO-MAX fragment if trigger pending (one-shot) |

## Integration Points

- **@sffmc/shared** — `PluginContext` type for the `server(ctx)` parameter; provides `.projectRoot`, `.config`, and the mutable namespace for `_autoMaxTrigger`.
- **@sffmc/watchdog** (implicit) — works alongside watchdog; same `tool.execute.after` hook domain. Watchdog detects loops; auto-max escalates when the loop persists.
- **yaml** — `parse()` from `yaml` v2 for reading `~/.config/SFFMC/auto-max.yaml`.
- **Filesystem** — `readFileSync` + `existsSync` from `fs`; `resolve` from `path`; `homedir` from `os` — all Node.js builtins, no external fs dependencies.
- **Max Mode consumer** (external) — downstream plugin or agent code reads the injected system prompt fragment to know it should activate parallel candidate generation.

## Public API

Exported from `src/coordinator.ts`, re-exported through `src/index.ts`:

| Symbol | Kind | Signature |
|---|---|---|
| `createSessionState` | Factory | `() => SessionState` |
| `recordFailure` | Mutator | `(state: SessionState, tool: string, errorType: string) => void` |
| `recordSuccess` | Mutator | `(state: SessionState, tool: string) => void` |
| `shouldTriggerMaxMode` | Predicate | `(state: SessionState, tool: string, errorType: string, config: AutoMaxConfig) => boolean` |
| `markTriggered` | Mutator | `(state: SessionState) => void` |
| `resetSession` | Mutator | `(state: SessionState) => void` |
| `AutoMaxConfig` | Type | `{ enabled, watchdog_threshold, max_mode_config: { n, judge_model }, cost_cap_per_session }` |
| `SessionState` | Type | `{ failCount: Map<string, number>, maxCallsThisSession: number, triggered: boolean }` |

Plugin export shape:
```ts
{ id: "@sffmc/auto-max", server: async (ctx: PluginContext) => HookMap }
```

## Configuration

Path: `~/.config/SFFMC/auto-max.yaml` (YAML v1, optional — defaults apply if missing or parse fails).

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Master on/off switch |
| `watchdog_threshold` | `3` | Consecutive same-tool-same-error failures before trigger |
| `max_mode_config.n` | `3` | Number of parallel candidates passed to Max Mode |
| `max_mode_config.judge_model` | `""` | Judge model for Max Mode candidate selection |
| `cost_cap_per_session` | `1` | Max triggers per session (safety limit) |
