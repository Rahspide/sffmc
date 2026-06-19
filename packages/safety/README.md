# @sffmc/safety

> **Safety composite.** Bundles 5 sub-features for tool-failure recovery, destructive-op safety nets, and log hygiene. Replaces the need to load each sub-feature individually.

safety composite — composes watchdog, rules, auto-max, eos-stripper, and log-whitelist via `mergeHooks()`.

## What it does

Prevents runaway failure cascades, blocks destructive commands via YAML gates, auto-escalates to stronger models when failures compound, strips local-model EOS tokens from output, and caps log accumulation at configurable thresholds. All 5 sub-features are always-on with per-feature YAML configs. No user-facing tools — everything is hooks.

## Sub-features

| Sub-feature | Purpose | MiMo origin |
|---|---|---|
| [watchdog](../watchdog/README.md) | 3-failure counter with auto-recovery and model promotion | MiMo origin |
| [rules](../rules/README.md) | YAML safety gates (denylist, command block, output pattern) | MiMo origin |
| [auto-max](../auto-max/README.md) | Auto-escalation to max-mode when failures cascade | SFFMC (inspired by MiMo) |
| [eos-stripper](../eos-stripper/README.md) | Strips local-model EOS tokens from `text.complete` output | SFFMC |
| [log-whitelist](../log-whitelist/README.md) | Prevents 12GB+ permission log accumulation | SFFMC |

## Hooks registered

9 unique hook keys (no tools). Composed via `mergeHooks()` in `src/index.ts`.

| Hook | Registered by | Purpose |
|---|---|---|
| `config` | watchdog, auto-max, eos-stripper, log-whitelist | Load per-feature YAML config on startup |
| `event` | watchdog, auto-max | Reset session counters on `session.created` |
| `tool.execute.after` | watchdog, auto-max, log-whitelist | Record success/failure; filter log output |
| `tool.execute.before` | rules | Evaluate YAML gates before tool dispatch |
| `permission.ask` | rules | Block or prompt on gated operations |
| `command.execute.before` | watchdog | `/max` escape hatch resets all counters |
| `experimental.chat.system.transform` | watchdog | Inject promotion fragment for escalated sessions |
| `experimental.chat.messages.transform` | watchdog | Reserved for verdict injection |
| `experimental.text.complete` | eos-stripper | Strip EOS tokens from model output |

## Tools

0 tools. Safety is hook-only — no user-facing tool surface.

## Skills

3 skills in `skills/`:

| Skill | Purpose |
|---|---|
| `safety:diagnose-tool-failure` | Diagnose tool-failure patterns and recommend recovery |
| `safety:write-rule` | Author or update YAML safety rules |
| `safety:manage-auto-max` | Tune auto-max thresholds and cost caps |

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/safety/src/index.ts"
  ]
}
```

## Configuration

Each sub-feature keeps its own YAML config at `~/.config/SFFMC/<name>.yaml`. The composite itself has no top-level `safety.yaml` — per-feature config namespaces are preserved for backward compatibility.

| Config file | Feature |
|---|---|
| `~/.config/SFFMC/watchdog.yaml` | Failure thresholds, promote model, error filter |
| `~/.config/SFFMC/rules.yaml` | Denylist, command block, output patterns |
| `~/.config/SFFMC/auto-max.yaml` | Escalation threshold, cost cap, enabled flag |
| `~/.config/SFFMC/eos-stripper.yaml` | EOS pattern list, log toggle |
| `~/.config/SFFMC/log-whitelist.yaml` | Whitelist/blacklist patterns, max lines, truncation marker |

Verify with `sffmc_health` — reports `safety: 9 hook keys, 0 tools`.

## Tests

```bash
bun test packages/safety/
```

## License

MIT
