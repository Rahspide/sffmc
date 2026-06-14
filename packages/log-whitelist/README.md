# @sffmc/log-whitelist

Filters verbose tool output and chat text to keep only lines matching a configurable whitelist. Reduces token noise by 5-15%.

## Why

Per MiMo-Code PR #604: OpenCode's tool output is verbose (DEBUG/INFO noise, deprecation warnings, stack traces for normal operations). When piped to the LLM as context, this noise:
- Wastes tokens on irrelevant log lines
- Confuses the agent into fixing non-issues (deprecation warnings)
- Causes 12GB+ log files in 30 days from permission-log spam

## How

Hooks into `tool.execute.after` (for bash/webfetch/etc output) and `experimental.text.complete` (for chat text):
1. Splits output into lines
2. Keeps lines matching any whitelist regex
3. Drops lines matching any blacklist regex (overrides whitelist)
4. Caps output at `max_kept_lines` with a truncation marker

**Default whitelist** keeps lines containing: error, warn, fail, exception, stack, exit code, permission denied, ENOENT, EACCES, command not found.

**Default blacklist** drops: deprecation warnings.

## Install

```bash
cp packages/log-whitelist/config/log.example.yaml ~/.config/SFFMC/log.yaml
```

Add to your opencode.json `plugin` array:
```json
"file:///data/projects/SFFMC/packages/log-whitelist/src/index.ts"
```

## Token cost

**-5% to -15%** (reduces noise, saves tokens). Pure filtering — no model calls.

## Compatible with

Any tool that produces verbose output: bash, webfetch, playwright, filesystem, commands, etc.
