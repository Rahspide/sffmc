# @sffmc/rules

> **Part of `@sffmc/safety` MSP.** This package is a sub-feature of the safety bundle. Load via `@sffmc/safety` for the full set (rules + watchdog + auto-max + eos-stripper + log-whitelist), or standalone if you only need rules.

F2 Rules — YAML gate-based allow/deny/ask for tool calls (W1).

## What it does

Blocks or warns on dangerous tool calls before they execute. Define rules in a YAML file; the plugin evaluates every `tool.execute.before` and `permission.ask` event against your rules and either denies (throws / sets status), allows silently, or asks (warns the user). A chokidar watcher hot-reloads the rules file on edit. If the YAML is unparseable, the plugin enters PANIC MODE and denies every call until you fix it.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/rules/src/index.ts"
  ]
}
```

## Configuration

Edit `~/.config/SFFMC/rules.yaml`:

```yaml
version: 1
rules:
  - match: { tool: read }
    action: allow
  - match: { tool: glob }
    action: allow
  - match: { tool: grep }
    action: allow
  - match: { tool: list }
    action: allow
  - match: { tool: write }
    action: allow
  - match: { tool: edit }
    action: allow
  - match:
      tool: write
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: edit
      path_outside: PROJECT_ROOT
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf /|chmod -R 777 /|mkfs\\."
    action: deny
  - match:
      tool: bash
      command_match: "rm -rf|chmod 777|chmod -R|dd if=|mkfs|DROP TABLE|TRUNCATE|git push --force|git reset --hard|>|sudo "
    action: ask
```

## Hooks registered

| Hook | Purpose |
|---|---|
| `tool.execute.before` | Evaluate rule against `tool` + args; throw on `deny`, warn on `ask` |
| `permission.ask` | Set `status = "deny"` if the rule denies the tool |

## Tests

```bash
bun test packages/rules/
```

21 tests in `src/index.test.ts`.

## License

MIT
