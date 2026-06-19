# @sffmc/watchdog

> **Part of `@sffmc/safety` composite.** This package is a sub-feature of the safety bundle. Load via `@sffmc/safety` for the full set (watchdog + rules + auto-max + eos-stripper + log-whitelist), or standalone if you only need watchdog.

Watchdog — 3-failure counter with auto-recovery and model promotion.

## What it does

Detects when the agent is stuck in a tool-failure loop. Tracks consecutive failures per tool per session in a rolling window; when a tool hits the threshold, the plugin injects a system-prompt fragment that promotes the session to a stronger model. When the same tool then succeeds, a "recovery verdict" is prepended to the tool output so the agent sees a clean signal. The `/max` slash command resets all counters as an escape hatch.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/watchdog/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/watchdog.yaml`:

```yaml
threshold: 3                     # consecutive failures before promote
rolling_window: 10               # track last N tool calls per session
promote_model: null              # null = same as primary; or override like "your-model-id"
error_class_filter:              # skip these (legitimate retries)
  - "fetch_429"                  # rate-limited retry is normal
  - "playwright_timeout"         # playwright retries are normal
  - "EAGAIN"                     # resource temporarily unavailable
log_failures: true               # write failures to plugin log
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `event` | Reset per-session counter on `session.created` |
| `tool.execute.after` | Record success/failure; on threshold, mark session promoted; on success after recovery, inject verdict |
| `experimental.chat.system.transform` | Push promotion fragment for promoted sessions (one-shot) |
| `command.execute.before` | `/max` → reset all counters and clear promoted/recovering state |

## Tests

```bash
bun test packages/watchdog/
```

20 tests in `src/index.test.ts`.

## License

MIT
