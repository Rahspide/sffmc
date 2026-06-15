# packages/

## Responsibility
SFFMC monorepo. 10 OpenCode plugins (9 features + 1 F3+ Health diagnostic) loaded as drop-in `file://` plugin paths. Each plugin is a self-contained TypeScript module with its own `package.json`, `src/`, `README.md`, `CHANGELOG.md`, and tests.

## Architecture: DLC (Drop-in Lattice Components)
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means `rm -rf packages/foo && bun test` should still pass for the remaining 9.

## Plugin Inventory (10 total)

| Plugin | Feature | Hooks Registered | @sffmc/shared | Notes |
|---|---|---|---|---|
| `memory` | F4' Memory + Context Recon 8K | `config`, `event`, `experimental.chat.messages.transform` | ✓ loadConfig | FTS5 + ICM extraction |
| `rules` | F2 Rules (safety net) | `tool.execute.before`, `permission.ask` | ✓ PluginContext | YAML gate-based allow/deny |
| `watchdog` | F1 Watchdog (auto-recovery) | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `command.execute.before` | ✓ PluginContext | 3-failure counter, `/max` escape hatch |
| `eos-stripper` | EOS token cleanup | `config`, `experimental.text.complete` | ✓ loadConfig | Local model survival |
| `log-whitelist` | Agent log filter | `config`, `tool.execute.after`, `experimental.text.complete` | ✓ loadConfig | 12GB log file prevention |
| `max-mode` | F7 Max Mode (parallel drafts) | `config`, `command.execute.before`, `experimental.chat.system.transform`, `tool.execute.before`, `experimental.chat.messages.transform` | ✗ custom | Complex sessionID/client types |
| `auto-max` | Auto-escalation to max-mode | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform` | ✓ PluginContext | Watchdog-driven trigger |
| `compose` | 15 compose skills (MiMo port) | `tool` (registers `compose_skill`) | ✓ PluginContext | Static .md file registry |
| `workflow` | W5-6 Dynamic Workflow engine | `tool` (registers `workflow`) | ✗ own type | quickjs-emscripten WASM sandbox |
| `health` | F3+ Health (diagnostic) | `tool` (registers `sffmc_health`) | ✓ PluginContext | 7 checks, JSON output |

**Adoption of `@sffmc/shared`**: 8/10 plugins use it. 2/10 keep custom types (max-mode, workflow) for legitimate domain reasons.

## Hook Conflict Map
Intentionally shared hooks (no conflict — each plugin writes own slot):
- `config` — 7 plugins register, all idempotent
- `event` — 3 plugins register (memory, watchdog, auto-max)
- `tool.execute.after` — 3 plugins register (watchdog, log-whitelist, auto-max)
- `experimental.chat.system.transform` — 3 plugins register (watchdog, max-mode, auto-max)
- `experimental.chat.messages.transform` — 3 plugins register (memory, watchdog, max-mode)
- `experimental.text.complete` — 2 plugins register (eos-stripper, log-whitelist)
- `command.execute.before` — 2 plugins register (watchdog, max-mode)
- `tool` — 2 plugins register (compose, workflow) — distinct tool names

See [docs/load-order-audit.md](../docs/load-order-audit.md) for the full structural analysis. Re-runnable via `python3 scripts/audit-load-order.py`.

## Build & Test

```bash
# Build all plugins to /tmp/sffmc-build
bun run build

# Test all (uses bunfig.toml to exclude dependencies/)
bun test

# Type-check (no global tsc needed, uses bun build --no-bundle)
bun run typecheck

# Run a single plugin's tests
cd packages/memory && bun test

# Audit hook conflicts
python3 scripts/audit-load-order.py

# Run F3+ Health diagnostic
bun run scripts/run-health.ts
```

## Adding a New Plugin

```bash
mkdir -p packages/my-feature/{src,tests}
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

Then add the plugin path to `~/.config/opencode/opencode.json` `plugin[]`.

## Sub-Map Directory

| Directory | Responsibility | Detailed Map |
|---|---|---|
| `packages/memory/` | F4' Memory + Context Recon 8K | [View Map](memory/codemap.md) |
| `packages/rules/` | F2 Rules (safety net) | [View Map](rules/codemap.md) |
| `packages/watchdog/` | F1 Watchdog (auto-recovery) | [View Map](watchdog/codemap.md) |
| `packages/eos-stripper/` | EOS token cleanup | [View Map](eos-stripper/codemap.md) |
| `packages/log-whitelist/` | Agent log filter | [View Map](log-whitelist/codemap.md) |
| `packages/max-mode/` | F7 Max Mode (parallel drafts) | [View Map](max-mode/codemap.md) |
| `packages/auto-max/` | Auto-escalation to max-mode | [View Map](auto-max/codemap.md) |
| `packages/compose/` | 15 compose skills (MiMo port) | [View Map](compose/codemap.md) |
| `packages/workflow/` | W5-6 Dynamic Workflow engine | [View Map](workflow/codemap.md) |
| `packages/health/` | F3+ Health (diagnostic) | [View Map](health/codemap.md) |
