# Repository Atlas: SFFMC

## Project Responsibility
SFFMC (Some Features From MiMo Code) — a Bun-workspace monorepo of **13 SFFMC packages** organized as **3 composites + 10 sub-features**, porting killer features from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) fork. Plugins are drop-in `file://` paths registered in `~/.config/opencode/opencode.json`. Architecture follows **DLC (Drop-in Lattice Components)**: each plugin reads freely, writes only to its own slot, has no shared state, and is hot-pluggable.

**3 composites** (use `mergeHooks()` to wire sub-features into one installable plugin):
- `@sffmc/safety` — wires watchdog, rules, auto-max, eos-stripper, log-whitelist (5 sub-features)
- `@sffmc/agentic` — wires max-mode, workflow, compose, health (4 sub-features)
- `@sffmc/memory` — standalone (F4' Memory + Context Recon 8K)

**10 sub-features** (composable, each is a drop-in plugin on its own).

## System Entry Points

| File | Purpose |
|---|---|
| `package.json` | Bun workspace root, `workspaces: ["packages/*", "shared"]`. Scripts: `test`, `build`, `typecheck`, `test:watch` |
| `tsconfig.json` | Strict TypeScript, ES2022, bundler resolution, no emit |
| `bunfig.toml` | Bun native config — `[test] pathIgnorePatterns = ["dependencies/**", "node_modules/**", ".slim/**", ".sffmc/**"]` scopes `bun test` to SFFMC only |
| `CHANGELOG.md` | Per-version release notes (v0.1.0 through v0.10.0) |
| `README.md` | Project overview, install one-liner, status table, repo layout |
| `CONTRIBUTING.md` | DLC architecture, plugin SDK reference, sandbox workflow, conventional commits |
| `install.sh` / `install.ps1` | One-liner installer: `curl -fsSL .../install.sh \| sh` clones to `~/.sffmc/plugins/sffmc` + auto-runs `sffmc init` |
| `bin/sffmc` / `bin/sffmc.ps1` | CLI with 6 subcommands: `init` (`--minimal\|--all\|--only p1,p2`), `update`, `uninstall`, `doctor`, `path`, `help` |
| `LICENSE` | MIT |
| `.git/hooks/pre-commit` | 4-gate hook: `bun test` + `bun run typecheck` + `python3 scripts/audit-load-order.py` + `bun run scripts/run-health.ts` |
| `scripts/audit-load-order.py` | AST-based hook conflict auditor (re-runnable) |
| `scripts/run-health.ts` | Invocation script for `@sffmc/health` — runs 12 checks, prints JSON |
| `scripts/audit-public-content.sh` | Scans for secrets + internal infra references in `config/*.example.yaml`, `skills/*.md`, `*.py`, `*.ts` |

## Plugin Architecture (DLC)

**DLC = Drop-in Lattice Components**:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

**Composites use `mergeHooks()`** (from `@sffmc/shared`) to reduce N sub-feature `PluginServer` returns into one. Three categories:
- **TRANSFORM hooks** (chain): `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete`
- **GATE hooks** (first-truthy-wins): `tool.execute.before`, `tool.execute.after`, `permission.ask`, `command.execute.before`
- **SIDE_EFFECT hooks** (all run, discard return): `config`, `event`, `experimental.session.start`, `experimental.session.end`

`rm -rf packages/foo && bun test` should still pass for the remaining 12.

## Directory Map (Aggregated)

| Directory | Responsibility | Detailed Map |
|---|---|---|
| `packages/` | Monorepo root for 13 SFFMC packages (3 composites + 10 sub-features) — DLC architecture, plugin inventory, hook conflict map | [View Map](packages/codemap.md) |
| `packages/safety/` | **Composite** — wires watchdog, rules, auto-max, eos-stripper, log-whitelist via `mergeHooks()`. 0 user tools, 9 hook types. | [View Map](packages/safety/codemap.md) |
| `packages/agentic/` | **Composite** — wires max-mode, workflow, compose, health via `mergeHooks()`. 3 tools (workflow, compose_skill, sffmc_health). | [View Map](packages/agentic/codemap.md) |
| `packages/memory/` | **Composite** (standalone) — F4' Memory + Context Recon 8K, FTS5 SQLite + ICM extraction + chokidar watcher + budgeted recon injection | [View Map](packages/memory/codemap.md) |
| `packages/rules/` | F2 Rules (safety net) — YAML gate-based allow/deny with panic-mode kill-switch + 1s mtime hot-reload | [View Map](packages/rules/codemap.md) |
| `packages/watchdog/` | F1 Watchdog (auto-recovery) — 3-failure rolling window counter + model promotion + recovery verdict + `/max` escape | [View Map](packages/watchdog/codemap.md) |
| `packages/eos-stripper/` | EOS token cleanup — end-only strip + EOS-only drop for local model survival (Ollama, vLLM, oMLX) | [View Map](packages/eos-stripper/codemap.md) |
| `packages/log-whitelist/` | Agent log filter — whitelist/blacklist + cap + truncate to prevent 12GB log files | [View Map](packages/log-whitelist/codemap.md) |
| `packages/max-mode/` | F7 Max Mode — schema-only tool trick (N candidates + judge) + restore state, 10-20% SWE-Bench Pro at 4-5x cost | [View Map](packages/max-mode/codemap.md) |
| `packages/auto-max/` | Auto-escalation to max-mode — session-scoped cost cap + watchdog-driven trigger + escalation fragment injection | [View Map](packages/auto-max/codemap.md) |
| `packages/compose/` | 15 compose skills (MiMo port) — static .md file registry + LLM-callable `compose_skill` tool | [View Map](packages/compose/codemap.md) |
| `packages/workflow/` | W5-6 Dynamic Workflow engine — quickjs-emscripten WASM sandbox + 3 primitives (agent/parallel/pipeline) + 4 builtins + 3-layer state + 5-layer budget (v0.10.0: class-based `WorkflowPersistence`/`EventBus`/`WorkspaceJail`, `WorkflowRuntime.close()`) | [View Map](packages/workflow/codemap.md) |
| `packages/health/` | F3+ Health (diagnostic) — 12-check diagnostic for plugin authors, JSON output via `sffmc_health` tool (v0.10.0: `paths` parameter added) | [View Map](packages/health/codemap.md) |
| `packages/extra/` | F3+ opt-in bundle (F5' Checkpoint + F6' Judge + F8 Dream) — factory+spread pattern, JSONL capture, multi-criteria LLM judge, Jaccard dedup, all features off by default | [View Map](packages/extra/codemap.md) |
| `shared/` | `@sffmc/shared` SDK — opt-in contract (loadConfig, PluginContext, EventBus, **mergeHooks** for composites), used by 12/13 packages | [View Map](shared/codemap.md) |

## Hook Conflict Map (13 packages, 0 conflicts)

Composites add **zero new hook keys** — they delegate to sub-features via `mergeHooks()`. So the conflict map at plugin level is unchanged:

Intentionally shared hooks (no conflict — each plugin writes own slot):
- `config` — 7 plugins register (idempotent)
- `event` — 3 plugins (memory, watchdog, auto-max)
- `tool.execute.after` — 3 plugins (watchdog, log-whitelist, auto-max)
- `experimental.chat.system.transform` — 3 plugins (watchdog, max-mode, auto-max)
- `experimental.chat.messages.transform` — 3 plugins (memory, watchdog, max-mode)
- `experimental.text.complete` — 2 plugins (eos-stripper, log-whitelist)
- `command.execute.before` — 2 plugins (watchdog, max-mode for `/max`)
- `tool` — 2 plugins (compose registers `compose_skill`, workflow registers `workflow` — distinct tool names)

Re-runnable via `python3 scripts/audit-load-order.py`. Full structural analysis in [docs/load-order-audit.md](docs/load-order-audit.md).

## @sffmc/shared Adoption Matrix

12/13 packages use `@sffmc/shared` (`loadConfig` + `PluginContext` type + `mergeHooks`):
- ✅ memory, rules, watchdog, eos-stripper, log-whitelist, auto-max, compose, health, extra, safety, agentic, workflow

1/13 keeps custom types (legitimate reason):
- ❌ max-mode — has complex `sessionID?` / `client?.session?.message?` types not in shared

## Build & Test

```bash
# Install all workspace deps
bun install

# Build all 13 packages to /tmp/sffmc-build
bun run build

# Test all 483 tests (uses bunfig.toml scope)
bun test

# Type-check (no global tsc; uses bun build --no-bundle)
bun run typecheck

# Watch mode — re-runs on every .ts save
bun run test:watch

# Run a single package's tests
cd packages/memory && bun test

# Audit hook conflicts
python3 scripts/audit-load-order.py

# Run F3+ Health diagnostic
bun run scripts/run-health.ts

# Audit public content (secrets + internal infra refs)
bash scripts/audit-public-content.sh

# Manual pre-commit (4 gates)
bash .git/hooks/pre-commit
```

## State

- **Tags**: v0.6.0, v0.6.1, v0.7.0, v0.7.2, v0.7.3, v0.7.4, v0.8.0, v0.8.1, v0.8.2, v0.9.0, v0.9.1, **v0.10.0** (12 total)
- **Tests**: 483/483 passing across 24 test files, 1285 expect() calls
- **sffmc_health**: 12 ok / 1 warn / 0 fail
- **Total LOC**: ~16,000+ across 13 packages
- **v0.10.0 BREAKING**: `WorkflowPersistence` class, `createEventBus()` factory, `WorkflowRuntime.close()`, `WorkspaceJail` class, `runtime-ref.ts` DELETED
- **Sandbox**: 10/10 SFFMC plugins loaded, 0 errors
- **Production**: 0 SFFMC (by design — sandbox first, prod later)
- **Install**: one-liner `curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh`

## OpenCode Plugin SDK Notes (1.17.x)

- The `tool` hook's **key** is the tool's name, NOT a `name` field inside the tool definition. Adding `name: "foo"` inside the object silently rejects the tool (regression bug fix-17, commit 4d6c928).
- Hooks return promises; LLM-callable tools expose via `tool: { name: def }` where `def` has `description`, `parameters` (JSON Schema or Zod), and `execute`.
- Composites use `mergeHooks()` from `@sffmc/shared` — plugins compose via `PluginServer` returns, NOT by sharing modules.
- See [CONTRIBUTING.md](CONTRIBUTING.md#plugin-sdk-quick-reference) for full hook reference.
