# packages/

## Responsibility
SFFMC monorepo. **13 OpenCode packages** organized as **3 composites + 10 sub-features**:
- **Composites** (3) — wire sub-features via `mergeHooks()` from `@sffmc/shared` into a single drop-in plugin. Composites own no logic of their own; they're 25-30 line reducers.
- **Sub-features** (10) — independent, drop-in plugins that can be installed standalone or via a composite.

Each package is a self-contained TypeScript module with its own `package.json`, `src/`, `README.md`, `CHANGELOG.md`, `skills/` (if applicable), and `test/`.

## Architecture: DLC (Drop-in Lattice Components)
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means `rm -rf packages/foo && bun test` should still pass for the remaining 12.

## Package Inventory (13 total: 3 composites + 10 sub-features)

### Composites (3)

| Package | Composes | Hooks | Tools | @sffmc/shared | Notes |
|---|---|---|---|---|---|
| `@sffmc/safety` | watchdog, rules, auto-max, eos-stripper, log-whitelist | 9 unique (from sub-features) | 0 | ✓ mergeHooks, PluginContext, PluginServer | All hook-only; GATE-hook dominance (4 of 5 sub-features) |
| `@sffmc/agentic` | max-mode, workflow, compose, health | (from sub-features) | 3 (workflow, compose_skill, sffmc_health) | ✓ mergeHooks, PluginContext, PluginServer | `compose_skill` is the LLM-callable tool to load any of 15 compose skills on demand |
| `@sffmc/memory` | (standalone F4' Memory + Context Recon 8K) | `config`, `event`, `experimental.chat.messages.transform` | 0 (or 1 if `memory_query` exposed) | ✓ loadConfig, PluginContext | FTS5 SQLite + ICM extraction + chokidar watcher + budgeted recon injection |

### Sub-features (10)

| Package | Feature | Hooks Registered | @sffmc/shared | Notes |
|---|---|---|---|---|
| `rules` | F2 Rules (safety net) | `tool.execute.before`, `permission.ask` | ✓ PluginContext | YAML gate-based allow/deny |
| `watchdog` | F1 Watchdog (auto-recovery) | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `command.execute.before` | ✓ PluginContext | 3-failure counter, `/max` escape hatch |
| `eos-stripper` | EOS token cleanup | `config`, `experimental.text.complete` | ✓ loadConfig | Local model survival |
| `log-whitelist` | Agent log filter | `config`, `tool.execute.after`, `experimental.text.complete` | ✓ loadConfig | 12GB log file prevention |
| `max-mode` | F7 Max Mode (parallel drafts) | `config`, `command.execute.before`, `experimental.chat.system.transform`, `tool.execute.before`, `experimental.chat.messages.transform` | ✗ custom | Complex sessionID/client types |
| `auto-max` | Auto-escalation to max-mode | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform` | ✓ PluginContext | Watchdog-driven trigger |
| `compose` | 15 compose skills (MiMo port) | `tool` (registers `compose_skill`) | ✓ PluginContext | Static .md file registry |
| `workflow` | W5-6 Dynamic Workflow engine | `tool` (registers `workflow`) | ✓ mergeHooks, WorkflowRuntime | quickjs-emscripten WASM sandbox. v0.10.0: class-based `WorkflowPersistence`/`EventBus`/`WorkspaceJail` |
| `health` | F3+ Health (diagnostic) | `tool` (registers `sffmc_health`) | ✓ PluginContext | 12 checks, JSON output. v0.10.0: `paths` parameter added |
| `extra` | F3+ opt-in bundle (F5' Checkpoint + F6' Judge + F8 Dream) | `tool` (registers `extra_checkpoint`, `extra_judge`, `extra_dream`) | ✓ PluginContext | All 3 features disabled by default; enabled features add `tool.execute.after` + `experimental.chat.messages.transform` hooks |

**Adoption of `@sffmc/shared`**: 12/13 packages use it. 1/13 (max-mode) keeps custom types for legitimate domain reasons.

## Hook Conflict Map (across all 13 packages)
Composites add **zero new hook keys** — they delegate to sub-features via `mergeHooks()`. Conflict map at plugin level:

Intentionally shared hooks (no conflict — each plugin writes own slot):
- `config` — 7 plugins register, all idempotent
- `event` — 3 plugins register (memory, watchdog, auto-max)
- `tool.execute.after` — 3 plugins register (watchdog, log-whitelist, auto-max)
- `experimental.chat.system.transform` — 3 plugins register (watchdog, max-mode, auto-max)
- `experimental.chat.messages.transform` — 3 plugins register (memory, watchdog, max-mode)
- `experimental.text.complete` — 2 plugins register (eos-stripper, log-whitelist)
- `command.execute.before` — 2 plugins register (watchdog, max-mode)
- `tool.execute.before` — 2 plugins register (max-mode, rules)
- `permission.ask` — 1 plugin (rules)
- `tool` — 2 plugins register (compose `compose_skill`, workflow `workflow` — distinct tool names)

Within composites, `mergeHooks()` enforces:
- **GATE** (first-truthy-wins): `tool.execute.before`, `tool.execute.after`, `permission.ask`, `command.execute.before`
- **TRANSFORM** (chain): `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.text.complete`
- **SIDE_EFFECT** (all run, discard return): `config`, `event`, `experimental.session.start`, `experimental.session.end`

See [docs/load-order-audit.md](../docs/load-order-audit.md) for the full structural analysis. Re-runnable via `python3 scripts/audit-load-order.py`.

## Build & Test

```bash
# Build all 13 packages to /tmp/sffmc-build
bun run build

# Test all (uses bunfig.toml to exclude dependencies/)
bun test

# Type-check (no global tsc needed, uses bun build --no-bundle)
bun run typecheck

# Run a single package's tests
cd packages/memory && bun test

# Audit hook conflicts
python3 scripts/audit-load-order.py

# Run F3+ Health diagnostic
bun run scripts/run-health.ts

# Audit public content (secrets + internal infra refs)
bash scripts/audit-public-content.sh
```

## Adding a New Package

```bash
mkdir -p packages/my-feature/{src,skills,test}
cat > packages/my-feature/package.json <<'EOF'
{
  "name": "@sffmc/my-feature",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": { "@sffmc/shared": "workspace:*" },
  "scripts": { "test": "bun test", "build": "tsc --noEmit" },
  "license": "MIT"
}
EOF
```

`src/index.ts` skeleton:
```ts
import { type PluginContext } from "@sffmc/shared"

export default {
  id: "@sffmc/my-feature",
  server: async (ctx: PluginContext) => {
    return {
      config: async (_cfg) => { /* startup */ },
      "tool.execute.before": async (toolCtx, args) => { /* gate */ },
    }
  },
}
```

Or for a composite that wires sub-features:
```ts
import { mergeHooks, type PluginContext, type PluginServer } from "@sffmc/shared"
import { server as feature1 } from "../feature1/src/index.ts"
import { server as feature2 } from "../feature2/src/index.ts"

export const id = "@sffmc/my-composite"
export const server = async (ctx: PluginContext): Promise<PluginServer> => {
  return { ...mergeHooks([await feature1(ctx), await feature2(ctx)]), id }
}
export default { id, server }
```

Then add the package path to `~/.config/opencode/opencode.json` `plugin[]`.

## Sub-Map Directory

| Directory | Responsibility | Detailed Map |
|---|---|---|
| `packages/safety/` | Composite — wires watchdog, rules, auto-max, eos-stripper, log-whitelist | [View Map](safety/codemap.md) |
| `packages/agentic/` | Composite — wires max-mode, workflow, compose, health | [View Map](agentic/codemap.md) |
| `packages/memory/` | F4' Memory + Context Recon 8K | [View Map](memory/codemap.md) |
| `packages/rules/` | F2 Rules (safety net) | [View Map](rules/codemap.md) |
| `packages/watchdog/` | F1 Watchdog (auto-recovery) | [View Map](watchdog/codemap.md) |
| `packages/eos-stripper/` | EOS token cleanup | [View Map](eos-stripper/codemap.md) |
| `packages/log-whitelist/` | Agent log filter | [View Map](log-whitelist/codemap.md) |
| `packages/max-mode/` | F7 Max Mode (parallel drafts) | [View Map](max-mode/codemap.md) |
| `packages/auto-max/` | Auto-escalation to max-mode | [View Map](auto-max/codemap.md) |
| `packages/compose/` | 15 compose skills (MiMo port) | [View Map](compose/codemap.md) |
| `packages/workflow/` | W5-6 Dynamic Workflow engine (v0.10.0 class-based API) | [View Map](workflow/codemap.md) |
| `packages/health/` | F3+ Health (diagnostic) | [View Map](health/codemap.md) |
| `packages/extra/` | F3+ opt-in bundle (Checkpoint + Judge + Dream) | [View Map](extra/codemap.md) |
