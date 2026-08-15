<div align="center">

<img src="docs/assets/logo.svg" alt="SFFMC" width="180" />

# ✨ SFFMC

### **S**ome **F**eature **f**rom **M**imo **C**ode

OpenCode plugins ported from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).  
**5 packages, MIT licensed, Bun-powered, zero fork required.**

---

[![GitHub release](https://img.shields.io/github/v/release/Rahspide/sffmc?color=amber&label=release)](https://github.com/Rahspide/sffmc/releases/latest)
[![npm](https://img.shields.io/npm/v/@sffmc/runtime?label=%40sffmc&color=amber)](https://www.npmjs.com/~Rahspide)
[![License: MIT](https://img.shields.io/badge/License-MIT-amber.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/Runtime-Bun-1.3.14-f472b6.svg)](https://bun.sh)
[![Tests](https://img.shields.io/badge/tests-1951%20%2F%20110%20files-success)](https://github.com/Rahspide/sffmc/actions)
[![Cleanroom](https://img.shields.io/badge/cleanroom-passing-success)](./scripts/check-cleanroom.sh)

[Install](#-install) · [Quick start](#-quick-start) · [Docs](#-documentation) · [Changelog](./CHANGELOG.md) · [Contributing](./CONTRIBUTING.md) · [Русский](./README.ru.md)

</div>

---

## 🤔 What is SFFMC?

SFFMC is a **Bun-workspace monorepo of OpenCode plugins** that bring the
productivity wins from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code)
into vanilla OpenCode, **no fork required**. Drop a few lines in
`opencode.json` and you get:

- 🤖 **A sandboxed workflow engine** -- write JS scripts with budget caps,
  resume, child workflows, 7 built-in workflows (`deep-research`,
  `security-audit`, `refactor`, `plan`, `tdd`, `doc-gen`, `lib-migrate`)
- 🛡️ **Safety gates** -- destructive-op protection, tool-failure recovery,
  auto-max escalation
- 🧠 **Memory recall** -- FTS5 search across sessions, checkpoint journaling,
  dream consolidation
- � **Max-mode** -- parallel candidate generation with LLM-as-judge selection
- 🔬 **Health checks** -- 13 diagnostics on the monorepo (hook conflicts,
  tests, version sync, type-check, public-content, ReDoS, cleanroom)

The name is a small wink at the upstream project: **S**ome **F**eature
**f**rom **M**imo **C**ode.

---

## 📦 What's in the box?

| Package | Role | Emoji |
|---------|------|-------|
| [`@sffmc/runtime`](./packages/runtime) | Workflow engine, sandbox, MCP bridge | ⚙️ |
| [`@sffmc/cognition`](./packages/cognition) | Max-mode reasoning, compose skills, health | 🧠 |
| [`@sffmc/memory`](./packages/memory) | Cross-session memory, judge, dream, checkpoint | 💾 |
| [`@sffmc/safety`](./packages/safety) | Watchdog, safety gates, auto-max | 🛡️ |
| [`@sffmc/utilities`](./packages/utilities) | Shared SDK (config, event-bus, hooks, paths) | 🔧 |

> `utilities` is a **library**, not a plugin -- it's consumed by the other 4
> packages via `workspace:*` and never appears in your `plugin` slot.

---

## � Install

### Option 1: npm (simplest)

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

### Option 2: one-liner (clones repo + auto-configures)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

### Option 3: from source

```bash
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

> 📖 **Full guide** (version pinning, troubleshooting, platform notes):
> [docs/install.md](./docs/install.md)

---

## ⚡ Quick start

Once installed, try this in any OpenCode chat:

```
/sffmc_health
```

You should see 13 diagnostics run in the terminal. Then try:

```
Run a deep-research workflow on the SFFMC safety engine
```

That's the workflow engine kicking in. From here, the sky's the limit:
write your own workflows in `~/.sffmc/plugins/sffmc/packages/runtime/workflows/`,
add rules to `@sffmc/safety`, extend memory with custom checkpoints.

---

## 🏗️ Architecture

SFFMC follows a **composite pattern**: each plugin reads freely from
other plugins' state but **writes only to its own slot**. No shared
state between plugins. Hot-pluggable: add or remove a package without
affecting others.

```
                  ┌────────────────────────────────────┐
                  │           OpenCode CLI             │
                  └────────────────┬───────────────────┘
                                   │ plugin slot
            ┌──────────────────────┼──────────────────────┐
            │                      │                      │
       ┌────▼─────┐          ┌─────▼────┐          ┌──────▼──────┐
       │  safety  │          │  memory  │          │   runtime   │
       │(composite)│          │(composite)│         │ (standalone)│
       │  rules   │          │  FTS5    │          │  sandbox    │
       │  watchdog│          │  recall  │          │  workflows  │
       │  auto-max│          │  dream   │          │             │
       └────┬─────�          └─────┬────┘          └──────┬──────┘
            │                      │                      │
            │                ┌─────▼────┐                 │
            │                │cognition │                 │
            └────────────────┤(standalone)│◄────────────────┘
                             │  max-mode │
                             │  compose  │
                             │  health   │
                             └─────┬────┘
                                   │
                            ┌──────▼──────┐
                            │ utilities   │
                            │ (library)   │
                            │  mergeHooks │
                            │  event-bus  │
                            │  config     │
                            └─────────────┘
```

**Hook categories** dispatched by `mergeHooks` from `@sffmc/utilities`:

| Category | Semantics | Hook keys |
|---|---|---|
| TRANSFORM | Chain (first -> last) | `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete` |
| GATE | First-truthy-wins | `tool.execute.before`, `tool.execute.after`, `permission.ask`, `command.execute.before` |
| SIDE_EFFECT | All run, return discarded | `config`, `event`, `experimental.session.start`, `experimental.session.end` |
| tool | Later-wins with warn | registered tool definitions |

> 📖 **Full SDK reference**: [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 📚 Documentation

| Doc | What's inside |
|-----|---------------|
| [📥 Getting started](./docs/getting-started.md) | Install, first workflow, debugging |
| [⚙️ Dynamic workflow](./docs/dynamic-workflow.md) | Sandbox internals, budgets, error model |
| [🧪 Workflow examples](./docs/workflow-examples.md) | 5 copy-paste workflows |
| [📥 Install guide](./docs/install.md) | Manual install, platform notes |
| [🔧 v0.16.0 porting guide](./docs/v0.16.0-decomposition.md) | God-class to sub-module migration |
| [🔄 Import from MiMo](./docs/import-from-mimo.md) | Migration for MiMo-Code users |
| [🚀 Drone CI](./docs/drone-ci.md) | CI pipeline reference |
| [✨ MiMo features](./docs/mimo-code-features.md) | What's ported, what's not |

---

## 🧪 Quality gates

Every commit runs a 7-step gate chain:

| # | Gate | What it checks |
|---|------|---------------|
| 1 | Cleanroom | Banned identifiers, external URLs, workflow-term regex |
| 2 | ReDoS audit | `safe-regex` over the redaction-rules catalogue |
| 3 | Load-order audit | AST-based hook-conflict detection |
| 4 | Test suite | 1951 tests across 110 files |
| 5 | Health summary | 13 monorepo diagnostics |
| 6 | Typecheck | `bun build --no-bundle` |
| 7 | Install frozen | `bun install --frozen-lockfile` |

> The `bun.lock` is regenerated on every version bump to keep workspace
> pins in sync with manifests.

---

## 🤝 Contributing

Fork, branch (`feature/<slug>`), edit, run `bun run precommit`, push,
open a PR. The CI runs the same 7 gates. See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the plugin SDK reference and
hook categories.

Local dev: clone, then add `file://` entries to `opencode.json`
pointing at your working copy -- your edits hot-reload without
re-running the installer.

---

## 📝 License

[MIT](./LICENSE) -- some functionality adapted from
[MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) under the upstream
license.

---

<sub>Built with 🧡 by Rahspide. Powered by Bun.</sub>
