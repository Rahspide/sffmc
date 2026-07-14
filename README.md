<div align="center">

<img src="docs/assets/logo.svg" alt="SFFMC" width="200" />

# SFFMC

OpenCode plugins ported from MiMo-Code. 5 packages, MIT, Bun-powered.

[![GitHub release](https://img.shields.io/github/v/release/Rahspide/sffmc?color=amber&label=release)](https://github.com/Rahspide/sffmc/releases/latest)
[![npm](https://img.shields.io/npm/v/@sffmc/runtime?label=%40sffmc&color=amber)](https://www.npmjs.com/~Rahspide)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-1.3.14-f472b6.svg)](https://bun.sh)

[Install](#install) · [Docs](#docs) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Русский](./README.ru.md)

</div>

---

## What is SFFMC?

SFFMC is a Bun-workspace monorepo of OpenCode plugins that bring the productivity wins from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) into vanilla OpenCode, no fork required. Drop a few lines in `opencode.json` and you get a sandboxed workflow engine, memory recall across sessions, max-mode parallel reasoning, safety gates, and a health-check toolchain.

## Install

SFFMC plugins are loaded by OpenCode via `file://` paths in `~/.config/opencode/opencode.json`. The one-liner below clones the repo and runs `sffmc init` to add the plugin paths automatically.

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

`install.sh` clones the repo to `~/.sffmc/plugins/sffmc` and runs `sffmc init` to add the default 4 plugins (safety, memory, runtime, cognition) to your OpenCode config. To add all 5 (including the `utilities` library):

```bash
sffmc init --all
```

Restart OpenCode after editing. Verify with:

```bash
sffmc doctor
```

The `npm` packages are published for programmatic use, not for OpenCode integration. See [docs/install.md](./docs/install.md) for full options (version pinning, custom install dir, manual config).

## Packages

| Package | Role | Category |
|---------|------|----------|
| `@sffmc/runtime` | Workflow engine, sandbox, MCP bridge | MiMo port |
| `@sffmc/cognition` | Max-mode reasoning, health checks | MiMo port |
| `@sffmc/memory` | Cross-session memory, judge, dream, checkpoint | Composite |
| `@sffmc/safety` | Watchdog, safety gates, auto-max | Composite |
| `@sffmc/utilities` | Shared lib: config, event-bus, merge-hooks, paths | Original |

## Features

- **Sandboxed workflow engine** - JS scripts with budget caps, resume, child workflows, 7 built-in workflows (deep-research, security-audit, refactor, plan, tdd, doc-gen, lib-migrate)
- **Safety gates** - destructive-op protection, tool-failure recovery, auto-max escalation
- **Memory recall** - FTS5 search, checkpoint journaling, dream consolidation
- **Max-mode** - parallel candidate generation with LLM-as-judge selection
- **Health checks** - 13 diagnostic checks on the monorepo (hook conflicts, tests, version sync, type-check, public-content, ReDoS, cleanroom)

## Docs

| Doc | What |
|-----|------|
| [Getting started](./docs/getting-started.md) | Install, first workflow, debugging |
| [Dynamic workflow](./docs/dynamic-workflow.md) | Sandbox internals, budgets, error model |
| [Workflow examples](./docs/workflow-examples.md) | 5 copy-paste workflows |
| [Install guide](./docs/install.md) | Manual install, platform notes |
| [v0.16.0 porting guide](./docs/v0.16.0-decomposition.md) | God-class to sub-module migration |
| [Import from MiMo](./docs/import-from-mimo.md) | Migration for MiMo-Code users |
| [Drone CI](./docs/drone-ci.md) | CI pipeline reference |
| [MiMo features](./docs/mimo-code-features.md) | What's ported, what's not |

## Architecture

SFFMC follows a **composite pattern**: each plugin reads freely from other plugins' state but writes only to its own slot. No shared state between plugins. Hot-pluggable: add or remove a package without affecting others.

```
runtime (engine)  cognition (reasoning)  utilities (shared lib)
       \                 |                    /
        \                |                   /
    safety (composite)     memory (composite)
```

See [codemap.md](./codemap.md) for the full repo atlas and [CONTRIBUTING.md](./CONTRIBUTING.md) for the plugin SDK reference.

## License

[MIT](./LICENSE). Some functionality adapted from [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) under the upstream license.
