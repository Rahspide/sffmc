# F2 Rules — Safety Net for Destructive Operations

Blocks or warns on dangerous tool calls. Define rules in a YAML file; the plugin evaluates every `tool.execute.before` and `permission.ask` event against your rules.

## Install

Copy the default rules and edit as needed:

```bash
mkdir -p ~/.config/SFFMC
cp config/rules.default.yaml ~/.config/SFFMC/rules.yaml
```

Then add to your OpenCode plugins:

```json
{
  "plugins": [
    {
      "id": "@sffmc/rules",
      "path": "/path/to/SFFMC/packages/rules/src/index.ts"
    }
  ]
}
```

## Default safety level

| Tool | Action |
|------|--------|
| `read`, `glob`, `grep`, `list` | allow |
| `write`, `edit` (inside project root) | allow |
| `write`, `edit` (outside project root) | deny |
| `bash` with `rm -rf`, `chmod 777`, etc. | ask |
| `bash` with `rm -rf /`, `chmod -R 777 /`, fork bombs | deny |

## Hot-reload

The watcher polls `~/.config/SFFMC/rules.yaml` every second. Edit the file — new rules take effect immediately without restart.

## Panic rule

If `rules.yaml` has a syntax error, the plugin enters **panic mode** and denies ALL tool calls. This is fail-closed: a broken config is safer than an unprotected agent. Fix the YAML syntax to clear panic mode.

## License

MIT
