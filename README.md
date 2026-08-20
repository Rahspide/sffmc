<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg" />
  <img src="docs/assets/logo.svg" alt="SFFMC" width="220" />
</picture>

### OpenCode plugins ported from Xiaomi MiMo-Code — drop in, no fork required

[**🚀 Quick start**](#-quick-start) · [**📖 Docs**](./docs/getting-started.md) · [**💬 Changelog**](./CHANGELOG.md) · [**🤝 Contributing**](./CONTRIBUTING.md)

[![GitHub release](https://img.shields.io/github/v/release/Rahspide/sffmc?color=f59e0b&label=release&logo=github)](https://github.com/Rahspide/sffmc/releases/latest)
[![npm](https://img.shields.io/npm/v/@sffmc/runtime?color=f59e0b&label=%40sffmc&logo=npm)](https://www.npmjs.com/~Rahspide)
[![Bun](https://img.shields.io/badge/runtime-bun%201.3.14-f472b6?logo=bun&logoColor=f472b6)](https://bun.sh)
[![Tests](https://img.shields.io/badge/tests-1946%20passing-22c55e?logo=vitest&logoColor=22c55e)](./CONTRIBUTING.md)
[![License: MIT](https://img.shields.io/badge/license-MIT-f59e0b)](./LICENSE)
[![Stars](https://img.shields.io/github/stars/Rahspide/sffmc?color=f59e0b&logo=github)](https://github.com/Rahspide/sffmc/stargazers)

[🇬🇧 English](./README.md) · [🇷🇺 Русский](./README.ru.md)

</div>

---

## ⚡ TL;DR

```bash
# 1. Install all five packages
npm install -g @sffmc/runtime @sffmc/cognition @sffmc/memory @sffmc/safety @sffmc/utilities

# 2. Add to ~/.config/opencode/opencode.json
# 3. Restart OpenCode
# 4. Verify
```

That's it. No fork, no patches, no rebuild.

---

## 🤔 Why SFFMC?

<table>
<tr>
<th width="50%">Vanilla OpenCode</th>
<th width="50%">OpenCode + SFFMC</th>
</tr>
<tr>
<td>Manual workflow scripts</td>
<td>⚙️ 7 built-in workflows (`deep-research`, `security-audit`, `refactor`, `plan`, `tdd`, `doc-gen`, `lib-migrate`)</td>
</tr>
<tr>
<td>Forgotten context between sessions</td>
<td>💾 FTS5 memory + dream consolidation</td>
</tr>
<tr>
<td>Dangerous tool calls slip through</td>
<td>🛡️ 5-layer safety gate + auto-max escalation</td>
</tr>
<tr>
<td>One answer per question</td>
<td>🧠 Max-mode with LLM-as-judge, picks the best of N candidates</td>
</tr>
<tr>
<td>No health visibility</td>
<td>🔬 13 monorepo diagnostics</td>
</tr>
</table>

**The name is a small wink at the upstream project:** **S**ome **F**eature **f**rom **M**imo **C**ode.

---

## ✨ What's in the box?

<table>
<tr>
<td width="50%" valign="top">

### ⚙️ Workflow engine
Sandboxed JS scripts with budget caps, resume, and child workflows. Write your own or copy one of the 7 built-ins.

</td>
<td width="50%" valign="top">

### 🛡️ Safety gates
Catch destructive operations before they hit the disk. Auto-recover from tool failures. Auto-escalate to max-mode when the model is stuck.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 💾 Cross-session memory
FTS5 search, checkpoint journaling, dream consolidation. Your context survives between chats — the model remembers yesterday's decisions.

</td>
<td width="50%" valign="top">

### 🧠 Max-mode reasoning
Generate N parallel candidates, pick the best with an LLM-as-judge. Higher quality answers without paying for retries.

</td>
</tr>
</table>

[📖 See the full feature list →](./docs/mimo-code-features.md)

---

## 📦 The 5 packages

| Package | Role | Type | Version |
|---|---|---|---|
| [`@sffmc/runtime`](./packages/runtime) | Sandboxed JS workflow orchestrator + 7 built-in workflows | Standalone plugin | ![npm](https://img.shields.io/npm/v/@sffmc/runtime?color=f59e0b) |
| [`@sffmc/cognition`](./packages/cognition) | Max-mode reasoning, compose skills, health diagnostics | Standalone plugin | ![npm](https://img.shields.io/npm/v/@sffmc/cognition?color=f59e0b) |
| [`@sffmc/memory`](./packages/memory) | Cross-session memory, judge, dream, checkpoint | **Composite** plugin | ![npm](https://img.shields.io/npm/v/@sffmc/memory?color=f59e0b) |
| [`@sffmc/safety`](./packages/safety) | Watchdog, safety gates, auto-max | **Composite** plugin | ![npm](https://img.shields.io/npm/v/@sffmc/safety?color=f59e0b) |
| [`@sffmc/utilities`](./packages/utilities) | Shared SDK — config, event-bus, hooks, paths | Library (no plugin slot) | ![npm](https://img.shields.io/npm/v/@sffmc/utilities?color=f59e0b) |

> **Composite** plugins can read state from other SFFMC plugins but only write to their own slot. `utilities` is consumed by the other four and never appears in your `plugin` array.

---

## 🚀 Quick start

Pick the install path that fits you best:

### Option A — npm (simplest)

```bash
npm install -g @sffmc/runtime @sffmc/cognition @sffmc/memory @sffmc/safety @sffmc/utilities
```

Then add the four plugins to `~/.config/opencode/opencode.json` (the order matters — composites first):

```jsonc
{
  "plugin": [
    "@sffmc/safety",    // composite: catches destructive ops
    "@sffmc/memory",    // composite: loads past context
    "@sffmc/runtime",   // standalone: workflow engine
    "@sffmc/cognition"  // standalone: max-mode reasoning
  ]
}
```

Restart OpenCode. Verify the install:

```
/sffmc_health
```

You should see 13 diagnostics run in the terminal. ✅

### Option B — one-liner (clones repo + auto-configures)

```bash
# macOS / Linux (requires SSH key on GitHub)
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

The script clones the repo, runs `sffmc init`, and edits `opencode.json` for you. Override the target branch with `SFFMC_VERSION=v0.16.3`.

### Option C — from source

```bash
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

> 📖 **Full install guide** (version pinning, troubleshooting, platform notes):
> [docs/install.md →](./docs/install.md)

---

## 🔧 CLI reference

Every install ships a `sffmc` binary:

| Command | What it does |
|---|---|
| `sffmc init` | Re-sync `opencode.json` with the 4 plugins |
| `sffmc init --all` | Install all 5 packages (including `utilities` library) |
| `sffmc init --yes` | Skip the confirmation prompt |
| `sffmc update` | `git pull` + re-run `init` |
| `sffmc doctor` | Run the 9-check diagnostic |
| `sffmc uninstall` | Remove all SFFMC entries from `opencode.json` |

> 💡 Run `sffmc doctor` after any OpenCode upgrade — it catches plugin loading order issues, missing dependencies, and config drift.

---

## 🏗️ Architecture

SFFMC follows a **composite pattern**:
- **Each plugin reads freely** from other plugins' state.
- **Each plugin writes only to its own slot** — no shared mutable state.
- **Hot-pluggable** — add or remove a package without touching the others.

<p align="center">
  <img src="docs/assets/architecture.svg" alt="SFFMC plugin architecture" width="760" />
</p>

**Hook categories** (dispatched by `mergeHooks` from `@sffmc/utilities`):

| Category | Semantics | Hook keys |
|---|---|---|
| `TRANSFORM` | Chain (first → last) | `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete` |
| `GATE` | First-truthy-wins | `tool.execute.before`, `tool.execute.after`, `permission.ask`, `command.execute.before` |
| `SIDE_EFFECT` | All run, return discarded | `config`, `event`, `experimental.session.start`, `experimental.session.end` |
| `tool` | Later-wins with warn | registered tool definitions |

> 📖 **Full SDK reference**: [CONTRIBUTING.md →](./CONTRIBUTING.md)

---

## 🎬 Demo: safety gate catches `rm -rf`

<p align="center">
  <img src="docs/assets/demo-safety-rm-rf.gif" alt="SFFMC safety gate intercepts a destructive rm -rf command" width="800" />
</p>

*Real SFFMC session — `@sffmc/safety` immediately **denies** `rm -rf /` (the `Error: [Rules] DENIED: ...` line is the verbatim output from `packages/safety/src/rules/index.ts`). For a less-dangerous `rm -rf /tmp/build` it **asks** (logs a `WARN`, then OpenCode shows its built-in permission dialog where the user clicks **Deny**).*

---

## 🧪 Quality gates

Every commit runs a 7-step gate chain. The `precommit` script runs the same gates locally:

| # | Gate | What it checks |
|---|---|---|
| 1 | 🚿 **Cleanroom** | Banned identifiers, external URLs, workflow-term regex |
| 2 | ⚡ **ReDoS audit** | `safe-regex` over the redaction-rules catalogue |
| 3 | 🔗 **Load-order audit** | AST-based hook-conflict detection |
| 4 | 🧪 **Test suite** | 1946 tests across 109 files |
| 5 | 💚 **Health summary** | 13 monorepo diagnostics |
| 6 | 📝 **Typecheck** | `bun build --no-bundle` |
| 7 | 🔒 **Install frozen** | `bun install --frozen-lockfile` |

```bash
bun run precommit   # runs gates 1–7 locally before push
```

> `bun.lock` is regenerated on every version bump to keep workspace pins in sync with manifests.

---

## 📚 Documentation

| Doc | What's inside |
|---|---|
| [📥 Getting started](./docs/getting-started.md) | Install, first workflow, debugging |
| [⚙️ Dynamic workflow](./docs/dynamic-workflow.md) | Sandbox internals, budgets, error model |
| [🧪 Workflow examples](./docs/workflow-examples.md) | 5 copy-paste workflows |
| [📥 Install guide](./docs/install.md) | Manual install, platform notes |
| [🚀 Drone CI](./docs/drone-ci.md) | CI pipeline reference |
| [✨ MiMo features](./docs/mimo-code-features.md) | What's ported, what's not |

---

## 🤝 Contributing

1. **Fork** the repo.
2. **Branch** with a descriptive name: `feature/<slug>` or `fix/<slug>`.
3. **Code with tests** — coverage matters. New hook category? Add a regression test and re-run `bun run audit:load-order`.
4. **Run** the local gate: `bun run precommit`.
5. **Push** and **open a PR** — CI runs the same 7 gates.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the plugin SDK reference, hook categories, and architectural decisions.

**Local dev workflow** — clone the repo, then add `file://` entries to your `opencode.json` pointing at your working copy:

```jsonc
{
  "plugin": [
    "file:///path/to/sffmc/packages/safety",
    "file:///path/to/sffmc/packages/memory",
    "file:///path/to/sffmc/packages/runtime",
    "file:///path/to/sffmc/packages/cognition"
  ]
}
```

Your edits hot-reload — no need to re-run the installer.

---

## 📝 License

[MIT](./LICENSE) — see the file for full text. Some functionality is adapted from [Xiaomi MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) under the upstream license.

---

<sub align="center">Built with 🧡 by <a href="https://github.com/Rahspide">@Rahspide</a> · Powered by <a href="https://bun.sh">Bun</a> · Inspired by <a href="https://github.com/XiaomiMiMo/MiMo-Code">Xiaomi MiMo-Code</a></sub>
