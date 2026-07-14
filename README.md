<div align="center">

> **Languages:** [English](README.md) | [Русский](README.ru.md)

# SFFMC

**OpenCode plugin suite — 2 composites + 3 standalones. MIT licensed. v0.16.0.**

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fsafety?label=%40sffmc%2Fsafety)](https://www.npmjs.com/package/@sffmc/safety)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fmemory?label=%40sffmc%2Fmemory)](https://www.npmjs.com/package/@sffmc/memory)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fruntime?label=%40sffmc%2Fruntime)](https://www.npmjs.com/package/@sffmc/runtime)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Fcognition?label=%40sffmc%2Fcognition)](https://www.npmjs.com/package/@sffmc/cognition)
[![npm version](https://img.shields.io/npm/v/%40sffmc%2Futilities?label=%40sffmc%2Futilities)](https://www.npmjs.com/package/@sffmc/utilities)

[**GitHub release**](https://github.com/Rahspide/sffmc/releases/tag/v0.16.0)
&nbsp;·&nbsp;
[**Getting started**](./docs/getting-started.md) &nbsp;·&nbsp; [**Contributing**](./CONTRIBUTING.md) &nbsp;·&nbsp; [**Changelog**](./CHANGELOG.md)

</div>

---

## What is SFFMC?

SFFMC is a Bun-workspace monorepo of OpenCode plugins that port the productivity
wins from Xiaomi's MiMo-Code fork into vanilla OpenCode — no fork required.
One `sffmc init` command (or a few lines in `opencode.json`) and you get
tool-failure recovery, destructive-op safety gates, cross-session memory recall,
parallel reasoning with judge selection, a sandboxed JavaScript workflow engine,
and 18 markdown compose skills.

The repo ships as **5 npm packages** under the `@sffmc/*` scope:

| Package | Type | What it does |
|---|---|---|
| `@sffmc/safety`    | composite   | 5 governance features (rules, watchdog, auto-max, eos-stripper, log-whitelist) |
| `@sffmc/memory`    | composite   | FTS5 recall + checkpoint / judge / dream opt-ins |
| `@sffmc/runtime`   | standalone  | Sandboxed JavaScript workflow orchestrator (quickjs-emscripten) |
| `@sffmc/cognition` | standalone  | Parallel reasoning (max-mode) + 18 compose skills + health diagnostics |
| `@sffmc/utilities` | **library** | Shared SDK. **Not a plugin entry** — only consumed via `workspace:*` dep by the other 4. |

Each composite is a thin wrapper that uses `mergeHooks()` from `@sffmc/utilities`
to combine its sub-features into one plugin entry. Standalones register themselves
directly. Every plugin is a **composite**: it reads any hook payload freely but
writes only to its own slot. No module-level exports, no shared mutable state,
no cross-plugin coupling. Load any combination — they compose cleanly.

Prior releases shipped `@sffmc/agentic` as a single monolithic composite.
Starting in v0.15.0, that composite is dissolved into `@sffmc/runtime` and
`@sffmc/cognition` — register both explicitly if you were using it.

## Why use it?

- **Installable from npm.** v0.15.0 was the first version where `npm install
  @sffmc/safety` resolves a public registry package; v0.16.0 is current.
- **Composable.** Load all 4 plugins or pick individual standalones.
  `mergeHooks()` handles hook collision for you.
- **Zero shared state.** Every plugin is composite. No side effects from load order.
- **MIT licensed.** Ported from MiMo-Code (Xiaomi) plus SFFMC team originals.
  Use freely in commercial and private projects.

## Install

> **v0.15.0** was the first version installable from **npm**. Pick one of:

### Option A — install via the `sffmc` CLI (recommended, all platforms)

The `sffmc` CLI writes the right entries to `opencode.json` for you and resolves
the npm packages at install time, so you don't paste JSON by hand:

```bash
# 1. install the CLI globally (once)
npm install -g @sffmc/safety @sffmc/memory @sffmc/runtime @sffmc/cognition

# 2. register everything in opencode.json
sffmc init
```

That's it. Restart OpenCode and the 4 plugins load via npm on first import.
Run `sffmc doctor` (or call the `sffmc_health` tool) to verify.

### Option B — manual edit of `opencode.json`

If you prefer to hand-edit (e.g. for reproducible dotfiles), paste this into
your `opencode.json` **as file content** — not into a terminal:

```json
{
  "plugins": {
    "@sffmc/safety":    "npm:@sffmc/safety@^0.16.0",
    "@sffmc/memory":    "npm:@sffmc/memory@^0.16.0",
    "@sffmc/runtime":   "npm:@sffmc/runtime@^0.16.0",
    "@sffmc/cognition": "npm:@sffmc/cognition@^0.16.0"
  }
}
```

> ⚠️ **Do not paste the JSON into PowerShell** — it would be parsed as
> a script block. Edit the file in your editor, or write it from PowerShell
> like this:
>
> ```powershell
> @"{\"plugins\":{\"@sffmc/safety\":\"npm:@sffmc/safety@^0.16.0\",...}}"@
> | Set-Content -Path "$HOME\.sffmc\opencode.json"
> ```
>
> See [`docs/install.md`](./docs/install.md#windows-powershell) for a complete
> PowerShell-safe walkthrough.

### Option C — one-liner installer (legacy `file://` mode)

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

The one-liner clones the repo to `~/.sffmc/plugins/sffmc` and runs
`sffmc init` to add 4 `file://` entries to your `opencode.json`.
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
| `sffmc init --all` | Add all 4 installable packages (utilities is a library, not a plugin) |
| `sffmc init --only runtime,cognition` | Pick specific packages |
| `sffmc update` | `git pull --ff-only` + re-sync config |
| `sffmc doctor` | Run 9-check diagnostic |
| `sffmc uninstall` | Remove all SFFMC entries from config |

See [`docs/install.md`](./docs/install.md) for the full guide (pinned versions, PATH setup, troubleshooting).

## What's new in v0.16.0

v0.16.0 decomposes 5 god-classes into 22 focused sub-modules (no breaking changes, public API preserved exactly across all 5 packages):

- **Structural refactor.** `dream.ts` (1291 → 10 LOC barrel + 6 sub-modules), `runtime.ts` (817 → 614), `judge.ts` (657 → 10 + 6 sub-modules), `mcp.ts` (335 → 26 + 3), `max-mode/index.ts` (328 → 31 + 3), `constants.ts` (345 → 17 + 2). Each sub-module has a single responsibility; public surface and behavior unchanged.
- **Pre-commit hook fix.** `bun run test` switched from single-process to per-file loop (`cd package && bun test <file>`) — the bun runner was leaking handles and hanging past 30 files. Pre-commit now exits 0 (10 ok / 3 warn / 0 fail; warnings are pre-existing infra).
- **Dead code + doc drift cleanup.** Removed `getMaxInstructions` export and `MaxModeResult` dead import; replaced stale `flushNow()` mention and "11 sub-component deps" wording in `packages/runtime/README.md`; dropped stale "LOC: ~1500" metadata in `docs/dynamic-workflow.md`.

See [CHANGELOG.md](./CHANGELOG.md) for the full v0.16.0 entry.

> **v0.15.0** was the consolidation (13 → 5 packages) and first public npm release. If you're upgrading from pre-v0.15.0, see [CHANGELOG.md](./CHANGELOG.md) v0.15.0 entry for the full migration map. Run `sffmc init` after upgrading.

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
opencode.json (4 file:// entries)
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
| [`@sffmc/runtime`](./packages/runtime/README.md) | standalone | Sandboxed JS workflow orchestrator (quickjs-emscripten WASM) | stable |
| [`@sffmc/cognition`](./packages/cognition/README.md) | standalone | Parallel reasoning (max-mode) + compose skills + health diagnostics | stable |
| [`@sffmc/utilities`](./packages/utilities/README.md) | library | Shared SDK (NOT a plugin; consumed as `workspace:*` dep) | stable |

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

**`~/.config/SFFMC/memory.yaml`** — opt-in advanced memory features (all disabled by default; `extra` package was dissolved into `@sffmc/memory` in v0.15.0):

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
- **[Hook audit info in codemap.md](./codemap.md#hook-categories)** — hook category dispatch (TRANSFORM / GATE / SIDE_EFFECT / tool) plus `bun run check:cleanroom` (0 conflicts expected) and `bun run audit:load-order` re-runs the AST-based conflict check on demand
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
(`mergeHooks`) and the `@sffmc/utilities` SDK. The 5 packages
cover watchdog, rules, memory, max-mode, compose, and health — see each
package's README for the surface area.

| Capability | SFFMC package | Description |
|---|---|---|
| Watchdog | `@sffmc/safety` | 3-failure rolling counter + recovery verdict |
| Rules | `@sffmc/safety` | YAML gate-based allow/deny for destructive commands |
| Memory | `@sffmc/memory` | FTS5 SQLite + context recall at session start |
| Checkpoint | `@sffmc/memory` | 200K resume with schema migration (opt-in) |
| Judge | `@sffmc/memory` | Multi-criteria verdict with streaming mode (opt-in) |
| Max Mode | `@sffmc/cognition` | Parallel drafts + judge selection |
| Dream | `@sffmc/memory` | Cluster naming + memory cleaning (opt-in) |
| Compose | `@sffmc/cognition` | 18 markdown skills |
| Dynamic Workflow | `@sffmc/runtime` | Sandboxed JS orchestrator |

## License

[MIT](./LICENSE) — see [LICENSE](./LICENSE) for full text.
