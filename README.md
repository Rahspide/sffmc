<div align="center">

> **Languages:** [English](README.md) | [Русский](README.ru.md)

# SFFMC

**OpenCode plugin suite — 2 composites + 3 standalones, MIT licensed. v0.15.0.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version 0.14.8](https://img.shields.io/badge/version-0.14.8-success)](https://github.com/Rahspide/sffmc/releases)

[**Packages**](./packages) &nbsp;·&nbsp; [**Getting started**](./docs/getting-started.md) &nbsp;·&nbsp; [**Contributing**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**Changelog**](./CHANGELOG.md)

</div>

---

## What is SFFMC?

SFFMC is a Bun-workspace monorepo of OpenCode plugins that port the productivity
wins from Xiaomi's MiMo-Code fork into vanilla OpenCode — no fork required.
One curl command and you get tool-failure recovery,
destructive-op safety gates, cross-session memory recall, parallel reasoning
with judge selection, a sandboxed JavaScript workflow engine, and 18 markdown
compose skills.

The repo ships as 14 npm packages under the `@sffmc/*` scope. Three of them are
**composites** — `@sffmc/safety` (5 governance features) and `@sffmc/memory` (FTS5 recall + checkpoint/judge/dream opt-ins). Three standalone packages: `@sffmc/runtime` (sandboxed JS workflow orchestrator), `@sffmc/cognition` (parallel reasoning + compose skills + health diagnostics), and `@sffmc/utilities` (shared SDK library; **not a plugin entry**, only consumed by other packages as `workspace:*` dep).
each of which is a thin wrapper that composes several sub-features into one
`mergeHooks()` from `@sffmc/utilities`. The three standalones
packages are the individual sub-features; they still work standalone for
backward compatibility.

Every plugin is a **composite**: it reads any hook payload
freely but writes only to its own slot. No module-level exports, no shared
mutable state, no cross-plugin coupling. Load any combination — all three
composites + standalones — they compose cleanly. The previously-dissolved `@sffmc/agentic` composite has been split into `@sffmc/runtime` + `@sffmc/cognition`; users must register both explicitly.

## Why use it?

- **Composable.** Load one composite package or all three, or pick individual
  sub-features. `mergeHooks()` handles hook collision for you.
- **Zero shared state.** Every plugin is composite. No side effects from load order.
- **Drop-in.** `curl ... | sh` then restart OpenCode. No build step, no npm
  install, no configuration required to start.
- **MIT licensed.** Ported from MiMo-Code (Xiaomi) plus SFFMC team originals.
  Use freely in commercial and private projects.

## Install

> **v0.15.0** — first version installable from **npm**. Pick one of:

### Option A — install via npm (recommended)

```bash
# After running sffmc init, each package is installed via npm at install time.
# Or pin a specific version in your opencode.json:
{
  "plugins": {
    "@sffmc/safety":    "npm:@sffmc/safety@^0.15.0",
    "@sffmc/memory":    "npm:@sffmc/memory@^0.15.0",
    "@sffmc/runtime":   "npm:@sffmc/runtime@^0.15.0",
    "@sffmc/cognition": "npm:@sffmc/cognition@^0.15.0"
  }
}
```

```bash
# Or install the registry packages globally for inspection:
npm install -g @sffmc/safety @sffmc/memory @sffmc/runtime @sffmc/cognition
```

### Option B — one-liner installer (legacy `file://` mode)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

The one-liner clones the repo to `~/.sffmc/plugins/sffmc` and runs
`sffmc init` to add 3 `file://` entries to your `opencode.json`.
Restart OpenCode, then verify with `sffmc doctor` or the `sffmc_health`
tool in any chat session.

```bash
# From source
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

### CLI quick reference

| Command | Effect |
|---|---|
| `sffmc init` | Auto-detect config + add 2 composite plugins + 2 standalones (safety, memory, runtime, cognition) |
| `sffmc init --all` | Add all 5 packages |
| `sffmc init --only workflow,compose` | Pick specific packages |
| `sffmc update` | `git pull --ff-only` + re-sync config |
| `sffmc doctor` | Run 13-check diagnostic |
| `sffmc uninstall` | Remove all SFFMC entries from config |

See [`docs/install.md`](./docs/install.md) for the full guide (pinned versions, PATH setup, troubleshooting).

## What's new in v0.14.8

- **Documentation split into English + Russian.** `README.md` is now English-only; a language picker banner at the top links to `README.ru.md`. `CHANGELOG.md` is now English-only; Russian translations live in `CHANGELOG.ru.md`. Both new files contain the same content as the original bilingual inline format, just split for cleaner per-language navigation. **v0.15.0 BREAKING**: code consolidation; 13 packages → 5. See CHANGELOG.md migration table for `@sffmc/<old>` → `@sffmc/<new>` mapping.

<details>
<summary>Want individual sub-features instead? (after `sffmc init --all`)</summary>

All 10 sub-feature packages still work standalone for backward compatibility:

| Sub-feature | Standalone path |
|---|---|
| watchdog | `file:///path/to/SFFMC/packages/watchdog/src/index.ts` |
| rules | `file:///path/to/SFFMC/packages/rules/src/index.ts` |
| auto-max | `file:///path/to/SFFMC/packages/auto-max/src/index.ts` |
| eos-stripper | `file:///path/to/SFFMC/packages/eos-stripper/src/index.ts` |
| log-whitelist | `file:///path/to/SFFMC/packages/log-whitelist/src/index.ts` |
| extra | `file:///path/to/SFFMC/packages/extra/src/index.ts` |
| max-mode | `file:///path/to/SFFMC/packages/max-mode/src/index.ts` |
| workflow | `file:///path/to/SFFMC/packages/workflow/src/index.ts` |
| compose | `file:///path/to/SFFMC/packages/compose/src/index.ts` |
| health | `file:///path/to/SFFMC/packages/health/src/index.ts` |

</details>

## Contents

- [What is SFFMC?](#what-is-sffmc)
- [Why use it?](#why-use-it)
- [Install](#install)
- [Architecture](#architecture)
- [Packages](#packages)
- [Hook example](#hook-example)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [Credits](#credits)
- [License](#license)

## Architecture

Each composite package is a thin wrapper that imports its sub-features and
passes them to `mergeHooks()` from `@sffmc/utilities`. The merger categorizes
hooks into TRANSFORM, GATE, SIDE_EFFECT, and tool — so output-mutation hooks
chain, permission gates aggregate, and side-effects run independently with no
collision. The result is a single default export that behaves exactly like
loading all sub-features individually, but with guaranteed hook ordering.

```
opencode.json (3 file:// entries)
         |
    +----+----+
    |         |
[safety]  [memory]                   <- composite packages (thin wrappers)
    |         |         |
    |    +----+----+    |
    |    |    |    |    |
    v    v    v    v    v
 +--+--+ +--+--+ +--+--+ +--+--+ +--+--+
 |watch| |rules| |auto| |eos- | |log- |
 |dog  | |     | |max | |strip| |white|
 +-----+ +-----+ +----+ +-----+ +-----+
   safety sub-features (5)

 +--+--+ +--+--+ +--+--+ +--+--+
 |mem- | |extra| |max- | |work-|
 |core | |     | |mode | |flow |
 +-----+ +-----+ +-----+ +-----+
   memory sub-features (3)       runtime + cognition standalones

                   +--+--+ +--+--+
                   |comp-| |heal-|
                   |ose  | |th   |
                   +-----+ +-----+

 +---------------------------------------------------+
 |                @sffmc/utilities (SDK)                 |
 |  loadConfig  |  PluginContext  |  mergeHooks  |  EventBus  |
 +---------------------------------------------------+
```

Sub-features are composite: each registers its own hooks and writes only to its own
namespace. The shared SDK provides type-safe config loading from
`~/.config/SFFMC/<name>.yaml`, a minimal plugin context type, a typed event
bus, and the `mergeHooks` composer.

## Packages

| Package | Composite | Role | Status |
|---|---|---|---|
| [`@sffmc/safety`](./packages/safety/README.md) | safety | Tool-failure recovery + destructive-op gates + log hygiene | stable |
| [`@sffmc/memory`](./packages/memory/README.md) | memory | Cross-session FTS5 recall + opt-in checkpoint/judge/dream | stable |
| [`@sffmc/safety`](./packages/safety/README.md) | composite | 5 governance features (rules, watchdog, auto-max, eos-stripper, log-whitelist) | stable |
| [`@sffmc/memory`](./packages/memory/README.md) | composite | FTS5 SQLite recall + checkpoint/judge/dream opt-ins | stable |
| [`@sffmc/runtime`](./packages/runtime/README.md) | standalone | Sandboxed JS workflow orchestrator (quickjs-emscripten WASM) | stable |
| [`@sffmc/cognition`](./packages/cognition/README.md) | standalone | Parallel reasoning (max-mode) + compose skills + health diagnostics | stable |
| [`@sffmc/utilities`](./packages/utilities/README.md) | library | Shared SDK (NOT a plugin; consumed as `workspace:*` dep) | stable |
| [`@sffmc/cognition`](./packages/cognition/README.md) | standalone | max-mode + compose (18 markdown skills for common workflows) + health (plugin diagnostics) | stable |
| [`@sffmc/utilities`](./packages/utilities/README.md) | — | SDK: loadConfig, PluginContext, EventBus, mergeHooks | stable |

## Hook example

A minimal OpenCode plugin that strips EOS tokens from local model output.
Import `@sffmc/utilities`, declare a config interface with defaults, register
on the `experimental.text.complete` hook, and mutate the output.

```ts
import { loadConfig, type PluginContext } from "@sffmc/utilities"

interface EosConfig { markers: string[] }
const defaults: EosConfig = { markers: ["<|im_end|>", "<|endoftext|>"] }

export default {
  id: "@sffmc/my-plugin",
  server: async (ctx: PluginContext) => {
    const config = await loadConfig<EosConfig>("my-plugin", defaults)
    return {
      "experimental.text.complete": async (_ctx, text: string) => {
        for (const m of config.markers) text = text.replaceAll(m, "")
        return text
      },
    }
  },
}
```

Register it in `~/.config/opencode/opencode.json`:

```jsonc
{
  "plugin": [
    "file:///path/to/SFFMC/packages/safety/src/index.ts",
    "file:///path/to/SFFMC/packages/memory/src/index.ts",
    "file:///path/to/SFFMC/packages/runtime/src/index.ts  (or packages/cognition/src/index.ts — both work)"
  ]
}
```

Restart OpenCode. The plugin loads, reads its YAML config (falling back to
defaults if the file is missing), and strips EOS markers from every model
response. Compose with other plugins by adding more `file://` entries — each
one writes to its own slot.

## Configuration

All plugins read YAML config from `~/.config/SFFMC/`. Create the files you
need; missing files fall back to safe defaults.

**`~/.config/SFFMC/watchdog.yaml`** — failure thresholds and recovery behavior:

```yaml
max_failures: 3
recovery_prompt: "The last 3 tool calls failed. Pause and diagnose the root cause before continuing."
auto_promote_model: true
promote_model: null  # inherits session primary model
```

**`~/.config/SFFMC/extra.yaml`** — opt-in advanced memory features (all disabled by default):

```yaml
checkpoint:
  enabled: false
  max_snapshots: 5
judge:
  enabled: false
  criteria: [completeness, correctness, conciseness]
dream:
  enabled: false
```

See each package's README for its full config reference and defaults.

## Documentation

- **[Getting started](./docs/getting-started.md)** — install, first workflow, debugging
- **[Import from MiMo](./docs/import-from-mimo.md)** — migration guide for MiMo-Code users
- **[Load order audit](./docs/load-order-audit.md)** — hook registration order and rationale
- **[Workflow reference](./docs/dynamic-workflow.md)** — sandbox internals, budgets, error model
- **[Workflow examples](./docs/workflow-examples.md)** — five ready-to-copy workflows
- **[v0.9.0 restructure decision](./CHANGELOG.md)** — see the v0.9.0 entry
  for why the 3-composite composition pattern replaced the per-feature
  install

## Contributing

Pull requests welcome. Each sub-feature is a standalone TypeScript module in
`packages/<name>/src/`. Composite packages are thin wrappers in
`packages/<name>/src/index.ts` that compose sub-features via `mergeHooks()`.
Read [CONTRIBUTING.md](./CONTRIBUTING.md) for the full workflow: branch naming,
test requirements, code style, and PR checklist.

## Credits

SFFMC ports features from [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code).
All ported features retain their original upstream attribution in source-file
headers. The SFFMC team contributed the composite-package composition layer
(`mergeHooks`), the `@sffmc/utilities` SDK, and four original sub-features:
auto-max, eos-stripper, log-whitelist, and health.

| Capability | SFFMC package | Description |
|---|---|---|
| Watchdog | `@sffmc/watchdog` | 3-failure rolling counter + recovery verdict |
| Rules | `@sffmc/rules` | YAML gate-based allow/deny for destructive commands |
| Memory | `@sffmc/memory` | FTS5 SQLite + context recall at session start |
| Checkpoint | `@sffmc/extra` | 200K resume with schema migration |
| Judge | `@sffmc/extra` | Multi-criteria verdict with streaming mode |
| Max Mode | `@sffmc/cognition/max-mode` | Parallel drafts + judge selection |
| Dream | `@sffmc/extra` | Cluster naming + memory cleaning |
| Compose | `@sffmc/cognition/compose` | 18 markdown skills |
| Dynamic Workflow | `@sffmc/workflow` | Sandboxed JS orchestrator |

## License

[MIT](./LICENSE) — see [LICENSE](./LICENSE) for full text.
