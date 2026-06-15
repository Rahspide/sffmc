# Repository Atlas: SFFMC

## Project Responsibility
SFFMC (Some Features From MiMo Code) — a Bun-workspace monorepo of 10 OpenCode plugins porting killer features from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) fork. Plugins are drop-in `file://` paths registered in `~/.config/opencode/opencode.json`. Architecture follows **DLC (Drop-in Lattice Components)**: each plugin reads freely, writes only to its own slot, has no shared state, and is hot-pluggable.

## System Entry Points

| File | Purpose |
|---|---|
| `package.json` | Bun workspace root, `workspaces: ["packages/*", "shared"]`. Scripts: `test`, `build`, `typecheck`, `test:watch` |
| `tsconfig.json` | Strict TypeScript, ES2022, bundler resolution, no emit |
| `bunfig.toml` | Bun native config — `[test] pathIgnorePatterns = ["dependencies/**", "node_modules/**", ".slim/**", ".sffmc/**"]` scopes `bun test` to SFFMC only |
| `CHANGELOG.md` | Per-version release notes (v0.1.0 through v0.7.4) |
| `README.md` | Project overview, quick start, status table, repo layout |
| `CONTRIBUTING.md` | DLC architecture, plugin SDK reference, sandbox workflow, conventional commits |
| `RELEASE.md` | Publication prep — 5 decisions needed (git remote, npm scope, CI, versioning, first package) |
| `LICENSE` | MIT |
| `.git/hooks/pre-commit` | 4-gate hook: `bun test` + `bun run typecheck` + `python3 scripts/audit-load-order.py` + `bun run scripts/run-health.ts` |
| `scripts/audit-load-order.py` | AST-based hook conflict auditor (re-runnable) |
| `scripts/run-health.ts` | Invocation script for `@sffmc/health` — runs 7 checks, prints JSON |

## Plugin Architecture (DLC)

**DLC = Drop-in Lattice Components**:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

`rm -rf packages/foo && bun test` should still pass for the remaining 9.

## Directory Map (Aggregated)

| Directory | Responsibility | Detailed Map |
|---|---|---|
| `packages/` | Monorepo root for 9 SFFMC plugins — DLC architecture, plugin inventory, hook conflict map | [View Map](packages/codemap.md) |
| `packages/memory/` | F4' Memory + Context Recon 8K — FTS5 SQLite + ICM extraction + chokidar watcher + budgeted recon injection | [View Map](packages/memory/codemap.md) |
| `packages/rules/` | F2 Rules (safety net) — YAML gate-based allow/deny with panic-mode kill-switch + 1s mtime hot-reload | [View Map](packages/rules/codemap.md) |
| `packages/watchdog/` | F1 Watchdog (auto-recovery) — 3-failure rolling window counter + model promotion + recovery verdict + `/max` escape | [View Map](packages/watchdog/codemap.md) |
| `packages/eos-stripper/` | EOS token cleanup — end-only strip + EOS-only drop for local model survival (Ollama, vLLM, oMLX) | [View Map](packages/eos-stripper/codemap.md) |
| `packages/log-whitelist/` | Agent log filter — whitelist/blacklist + cap + truncate to prevent 12GB log files | [View Map](packages/log-whitelist/codemap.md) |
| `packages/max-mode/` | F7 Max Mode — schema-only tool trick (N candidates + judge) + restore state, 10-20% SWE-Bench Pro at 4-5x cost | [View Map](packages/max-mode/codemap.md) |
| `packages/auto-max/` | Auto-escalation to max-mode — session-scoped cost cap + watchdog-driven trigger + escalation fragment injection | [View Map](packages/auto-max/codemap.md) |
| `packages/compose/` | 15 compose skills (MiMo port) — static .md file registry + LLM-callable `compose_skill` tool | [View Map](packages/compose/codemap.md) |
| `packages/workflow/` | W5-6 Dynamic Workflow engine — quickjs-emscripten WASM sandbox + 3 primitives (agent/parallel/pipeline) + 4 builtins + 3-layer state + 5-layer budget | [View Map](packages/workflow/codemap.md) |
| `packages/health/` | F3+ Health (diagnostic) — 7-check diagnostic for plugin authors, JSON output via `sffmc_health` tool | [View Map](packages/health/codemap.md) |
| `shared/` | `@sffmc/shared` SDK — opt-in contract (loadConfig, PluginContext, EventBus), used by 8/10 plugins | [View Map](shared/codemap.md) |

## Hook Conflict Map (10 plugins, 0 conflicts)

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

8/10 plugins use `@sffmc/shared` (loadConfig + PluginContext type):
- ✅ memory, rules, watchdog, eos-stripper, log-whitelist, auto-max, compose, health

2/10 keep custom types (legitimate reasons):
- ❌ max-mode — has complex `sessionID?` / `client?.session?.message?` types not in shared
- ❌ workflow — has its own type from `runtime.ts` (runtime-specific)

## Build & Test

```bash
# Install all workspace deps
bun install

# Build all 10 packages to /tmp/sffmc-build
bun run build

# Test all 292 tests (uses bunfig.toml scope)
bun test

# Type-check (no global tsc; uses bun build --no-bundle)
bun run typecheck

# Watch mode — re-runs on every .ts save
bun run test:watch

# Run a single plugin's tests
cd packages/memory && bun test

# Audit hook conflicts
python3 scripts/audit-load-order.py

# Run F3+ Health diagnostic
bun run scripts/run-health.ts

# Manual pre-commit (4 gates)
bash .git/hooks/pre-commit
```

## State

- **Tags**: v0.6.0, v0.6.1, v0.7.0, v0.7.2, v0.7.3, v0.7.4 (6 total)
- **Tests**: 292/292 passing across 16 test files
- **sffmc_health**: 7/7 ok
- **Total LOC**: ~10,000+ across 10 packages
- **Sandbox :4200**: 10/10 SFFMC plugins loaded, 0 errors
- **Prod :4100**: 0 SFFMC (by design — sandbox first, prod later)

## OpenCode Plugin SDK Notes (1.17.x)

- The `tool` hook's **key** is the tool's name, NOT a `name` field inside the tool definition. Adding `name: "foo"` inside the object silently rejects the tool (regression bug fix-17, commit 4d6c928).
- Hooks return promises; LLM-callable tools expose via `tool: { name: def }` where `def` has `description`, `parameters` (JSON Schema or Zod), and `execute`.
- See [CONTRIBUTING.md](CONTRIBUTING.md#plugin-sdk-quick-reference) for full hook reference.
