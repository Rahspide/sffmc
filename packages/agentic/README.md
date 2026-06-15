# @sffmc/agentic

> **Agentic MSP.** Bundles 4 sub-features for parallel reasoning, sandboxed multi-step execution, on-demand skill composition, and plugin health diagnostics. Replaces the need to load each sub-feature individually.

agentic MSP — composes max-mode (F7), workflow (W5-6), compose (W4), and health (F3+) via `mergeHooks()`.

## What it does

Provides parallel candidate generation with judge-model evaluation, sandboxed JS workflow execution with 7 built-in topologies, on-demand loading of 18 markdown skills, and a unified `sffmc_health` tool that audits hook conflicts, verifies package integrity, and reports cross-plugin health in one call.

## Sub-features

| Sub-feature | Purpose | MiMo origin |
|---|---|---|
| [max-mode](../max-mode/README.md) | 3 parallel candidate generators + 1 judge model | F7 (MiMo) |
| [workflow](../workflow/README.md) | Sandboxed JS execution with 7 builtins (deep-research, security-audit, tdd, refactor, plan, doc-gen, lib-migrate) | W5-6 (MiMo) |
| [compose](../compose/README.md) | 18 markdown skills loaded via `compose_skill` tool (15 from MiMo + 3 SFFMC) | W4 (MiMo) |
| [health](../health/README.md) | `sffmc_health` tool — 12 checks (Phase 6 adds 13th) | F3+ (SFFMC) |

## Hooks registered

5 unique hook keys. Composed via `mergeHooks()` in `src/index.ts`.

| Hook | Registered by | Purpose |
|---|---|---|
| `config` | workflow | Recover orphaned workflows on startup |
| `command.execute.before` | max-mode | Intercept `/max` and other slash commands |
| `tool.execute.before` | max-mode | Intercept tool calls for candidate dispatch |
| `experimental.chat.system.transform` | max-mode | Inject candidate-generation system prompt |
| `experimental.chat.messages.transform` | max-mode | Wrap messages for multi-model dispatch |

## Tools

3 user-facing tools.

| Tool | Package | Purpose |
|---|---|---|
| `workflow` | workflow | Execute a sandboxed multi-step workflow by topology name |
| `compose_skill` | compose | Load a compose-mode skill (verify, tdd, plan, etc.) by name |
| `sffmc_health` | health | Run 12 cross-plugin health checks (hook conflicts, integrity, presence) |

## Skills

5 skills in `skills/`:

| Skill | Purpose |
|---|---|
| `agentic:run-workflow` | Guide agent through workflow topology selection and execution |
| `agentic:run-max-mode` | Configure and invoke multi-candidate generation with judge |
| `agentic:compose-skill` | Select and load the right compose-mode skill for a task |
| `agentic:health-check` | Diagnose plugin misconfiguration with `sffmc_health` |
| `agentic:resolve-hook-conflict` | Resolve overlapping hook registrations between plugins |

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode-sandbox/opencode.json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/agentic/src/index.ts"
  ]
}
```

## Configuration

max-mode reads `~/.config/SFFMC/max-mode.yaml` for candidate count, model list, and temperature. The other sub-features (workflow, compose, health) have no per-feature config — they use internal defaults or runtime state.

| Config file | Feature |
|---|---|
| `~/.config/SFFMC/max-mode.yaml` | Candidate count, model list, temperature, cost cap |

## Tests

```bash
bun test packages/agentic/
```

## License

MIT
