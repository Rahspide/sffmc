<div align="center">

<img src="docs/assets/logo.svg" alt="SFFMC" width="180" />

# SFFMC

### **S**ome **F**eature **f**rom **M**imo **C**ode

OpenCode plugins from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) — drop in, no fork required.

[![GitHub release](https://img.shields.io/github/v/release/Rahspide/sffmc?color=amber&label=release)](https://github.com/Rahspide/sffmc/releases/latest)
[![npm](https://img.shields.io/npm/v/@sffmc/runtime?label=%40sffmc&color=amber)](https://www.npmjs.com/~Rahspide)
[![Bun](https://img.shields.io/badge/bun-1.3.14-f472b6)](https://bun.sh)
[![Tests](https://img.shields.io/badge/tests-1951%20%2F%20110%20files-success)](https://github.com/Rahspide/sffmc/actions)

[Install](#-install) · [Quick start](#-quick-start) · [Docs](#-documentation) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Русский](./README.ru.md)

</div>

—-

## 🤔 What is SFFMC?

SFFMC ships the productivity wins from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) as ordinary OpenCode plugins. No fork, no patches — just `npm install` and a few lines in `opencode.json`, and you've got:

- ⚙️ **A sandboxed workflow engine** — write JS scripts with budget caps, resume, child workflows, and 7 built-in workflows (`deep-research`, `security-audit`, `refactor`, `plan`, `tdd`, `doc-gen`, `lib-migrate`).
- 🛡️ **Safety gates** that catch destructive ops, recover from tool failures, and escalate to max mode when needed.
- 💾 **Cross-session memory** with FTS5 search, checkpoint journaling, and dream consolidation — your context survives between chats.
- 🧠 **Max-mode reasoning** that generates parallel candidates and picks the best with an LLM-as-judge.
- 🔬 **Health checks** — 13 monorepo diagnostics that catch hook conflicts, test failures, version drift, and ReDoS regressions before they ship.

The name is a small wink at the upstream project: **S**ome **F**eature **f**rom **M**imo **C**ode.

—-

## 📦 What's in the box?

| Package | Role |
|————-|———|
| [`@sffmc/runtime`](./packages/runtime) | ⚙️ Sandboxed JS workflow orchestrator + 7 built-in workflows |
| [`@sffmc/cognition`](./packages/cognition) | 🧠 Max-mode reasoning, compose skills, health diagnostics |
| [`@sffmc/memory`](./packages/memory) | 💾 Cross-session memory, judge, dream, checkpoint |
| [`@sffmc/safety`](./packages/safety) | 🛡️ Watchdog, safety gates, auto-max |
| [`@sffmc/utilities`](./packages/utilities) | 🔧 Shared SDK — config, event-bus, hooks, paths |

> `utilities` is a **library**, not a plugin — it's consumed by the other four packages and never appears in your `plugin` slot.

—-

## 📥 Install

Pick whichever path suits you:

### npm (simplest)

```bash
npm install -g @sffmc/runtime @sffmc/cognition @sffmc/memory @sffmc/safety @sffmc/utilities
```

Then add to `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "@sffmc/safety",
    "@sffmc/memory",
    "@sffmc/runtime",
    "@sffmc/cognition"
  ]
}
```

Restart OpenCode. Verify with `sffmc doctor` or type `sffmc_health` in any chat.

### One-liner (clones repo + auto-configures)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

### From source

```bash
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

> 📖 **Full guide** (version pinning, troubleshooting, platform notes):
> [docs/install.md](./docs/install.md)

—-

## ⚡ Quick start

Once installed, try this in any OpenCode chat:

```
/sffmc_health
```

You should see 13 diagnostics run in the terminal. Then try:

```
Run a deep-research workflow on the SFFMC safety engine
```

That's the workflow engine kicking in. From here: write your own
workflows, add rules to `@sffmc/safety`, extend memory with custom
checkpoints.

—-

## 🏗️ Architecture

SFFMC follows a **composite pattern**: each plugin reads freely from
other plugins' state but **writes only to its own slot**. No shared
state between plugins. Hot-pluggable — add or remove a package
without affecting the others.

```
                  ┌─────────────────────┐
                  │     OpenCode CLI    │
                  └──────────�──────────┘
                             │ plugin slot
            ┌────────────────┼────────────────┐
            │                │                │
     ┌──────▼──────┐   ┌──────▼──────┐   ┌──────▼──────┐
     │   safety    │   │   memory    │   │   runtime   │
     │  composite  │   │  composite  │   │ standalone  │
     └──────┬──────┘   └──────┬──────┘   └──────┬──────┘
            │                │                │
            └────────────────┼────────────────┘
                             │
                      ┌──────▼──────┐
                      │  cognition  │
                      │ standalone  │
                      └──────┬──────┘
                             │
                      ┌──────▼──────�
                      │ utilities   │
                      │   library   │
                      └─────────────┘
```

Hook categories (dispatched by `mergeHooks` from `@sffmc/utilities`):

| Category | Semantics | Hook keys |
|—-|—-|—-|
| TRANSFORM | Chain (first → last) | `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete` |
| GATE | First-truthy-wins | `tool.execute.before`, `tool.execute.after`, `permission.ask`, `command.execute.before` |
| SIDE_EFFECT | All run, return discarded | `config`, `event`, `experimental.session.start`, `experimental.session.end` |
| tool | Later-wins with warn | registered tool definitions |

> 📖 **Full SDK reference**: [CONTRIBUTING.md](./CONTRIBUTING.md)

—-

## 📚 Documentation

| Doc | What's inside |
|——-|———————-|
| [📥 Getting started](./docs/getting-started.md) | Install, first workflow, debugging |
| [⚙️ Dynamic workflow](./docs/dynamic-workflow.md) | Sandbox internals, budgets, error model |
| [🧪 Workflow examples](./docs/workflow-examples.md) | 5 copy-paste workflows |
| [📥 Install guide](./docs/install.md) | Manual install, platform notes |
| [🔧 v0.16.0 porting guide](./docs/v0.16.0-decomposition.md) | God-class to sub-module migration |
| [🔄 Import from MiMo](./docs/import-from-mimo.md) | Migration for MiMo-Code users |
| [🚀 Drone CI](./docs/drone-ci.md) | CI pipeline reference |
| [✨ MiMo features](./docs/mimo-code-features.md) | What's ported, what's not |

—-

## 🧪 Quality gates

Every commit runs a 7-step gate chain:

| # | Gate | What it checks |
|—-|———|———————-|
| 1 | Cleanroom | Banned identifiers, external URLs, workflow-term regex |
| 2 | ReDoS audit | `safe-regex` over the redaction-rules catalogue |
| 3 | Load-order audit | AST-based hook-conflict detection |
| 4 | Test suite | 1951 tests across 110 files |
| 5 | Health summary | 13 monorepo diagnostics |
| 6 | Typecheck | `bun build —no-bundle` |
| 7 | Install frozen | `bun install —frozen-lockfile` |

> The `bun.lock` is regenerated on every version bump to keep
> workspace pins in sync with manifests.

—-

## 🤝 Contributing

Fork, branch (`feature/<slug>`), edit, run `bun run precommit`, push,
open a PR. The CI runs the same 7 gates. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the plugin SDK reference and
hook categories.

Local dev: clone, then add `file://` entries to `opencode.json`
pointing at your working copy — your edits hot-reload without
re-running the installer.

—-

## 📝 License

[MIT](./LICENSE) — see the file for full text. Some functionality is
adapted from [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)
under the upstream license.

—-

<sub>Built with 🧡 by Rahspide. Powered by Bun.</sub>
