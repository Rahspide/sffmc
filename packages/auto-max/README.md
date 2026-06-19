# @sffmc/auto-max

> **Part of `@sffmc/safety` composite.** This package is a sub-feature of the safety bundle. Load via `@sffmc/safety` for the full set (auto-max + watchdog + rules + eos-stripper + log-whitelist), or standalone if you only need auto-max.



Auto-escalates to Max Mode when a tool is stuck in a failure loop (threshold from watchdog config).

## What it does

Sits next to `@sffmc/watchdog` and counts consecutive failures per tool per session. When the count hits `watchdog_threshold` (default 3) and `auto-max` is enabled, the plugin marks the session, logs the trigger, and emits a system-prompt fragment announcing "AUTO-MAX TRIGGERED" with the failing tool and error type. Max Mode then takes over to break the loop. A per-session `cost_cap_per_session` (default 1) prevents runaway triggering.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/auto-max/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/auto-max.yaml`:

```yaml
# Auto-Max Triggers — plugin config

version: 1

# Enable/disable the entire plugin
enabled: true

# Number of consecutive same-tool failures before triggering Max Mode
watchdog_threshold: 3

# Max Mode configuration passed through on trigger
max_mode_config:
  n: 3
  # Use any chat-capable model identifier from your provider config.
  judge_model: your-model-id

# Maximum Max Mode invocations per session (safety cap)
# 1 = only fire once per session, even if stuck again
cost_cap_per_session: 1
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Load config, log enabled/disabled banner with threshold + cap |
| `event` | Reset per-session state on `session.created` |
| `tool.execute.after` | Track success/failure per tool; on threshold, set `_autoMaxTrigger` on ctx and append to triggered log |
| `experimental.chat.system.transform` | If a trigger is pending, push the AUTO-MAX TRIGGERED fragment (one-shot) |

## Tests

```bash
bun test packages/auto-max/
```

(Tests live in the root `bun test` suite — see root README.)

## License

MIT
