# @sffmc/log-whitelist

> **Part of `@sffmc/safety` MSP.** This package is a sub-feature of the safety bundle. Load via `@sffmc/safety` for the full set (log-whitelist + watchdog + rules + auto-max + eos-stripper), or standalone if you only need log-whitelist.



Agent log filter — keeps only whitelist-matching lines in tool output and chat text (W2).

## What it does

Filters verbose tool output and chat text to keep only lines matching a configurable whitelist of regex patterns. Blacklist patterns override the whitelist. Output is capped at `max_kept_lines` and truncated with a marker. Reduces token noise by 5–15% in chatty tool outputs (build logs, test runners, etc.). Runs *after* `eos-stripper` in the `experimental.text.complete` chain.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode-sandbox/opencode.json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/log-whitelist/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/log.yaml`:

```yaml
whitelist:                       # keep lines matching any of these
  - '(?i)error'
  - '(?i)warn'
  - '(?i)fail'
  - '(?i)exception'
  - '(?i)stack'
  - '(?i)exit code'
  - '(?i)permission denied'
  - '(?i)enoent'
  - '(?i)eacces'
  - '(?i)command not found'
blacklist:                       # drop lines matching these (overrides whitelist)
  - '(?i)deprecat'               # deprecation warnings are noise
max_kept_lines: 50               # cap kept output
truncate_marker: '... [N more lines]'  # shown when truncated
log_filtered_count: true
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Compile whitelist/blacklist regexes at startup |
| `tool.execute.after` | Filter string output line-by-line; rewrite `result.output` if any line dropped |
| `experimental.text.complete` | Filter chat text parts the same way (runs after `eos-stripper`) |

## Tests

```bash
bun test packages/log-whitelist/
```

14 tests in `src/index.test.ts`.

## License

MIT
