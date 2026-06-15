# SFFMC — Some Features From MiMo Code

OpenCode plugin suite porting killer features from Xiaomi's MiMo-Code fork.
MIT licensed. Monorepo. **v0.9.0** (3-MSP restructure of v0.8.x).

## What is this

3 Multi-Plugin Packages (MSPs), 14 sub-feature packages, 480 tests passing.
Killer features from MiMo-Code v8.0 ported as OpenCode plugins plus SFFMC
team additions. Each MSP composes its sub-features via `mergeHooks()` from
`@sffmc/shared`.

### The 3 MSPs

| MSP | Sub-features | Hooks | Tools | Skills |
|---|---|---|---|---|
| **`@sffmc/safety`** | 5 (watchdog, rules, auto-max, eos-stripper, log-whitelist) | 9 keys | 0 | 3 |
| **`@sffmc/memory`** | 4 (memory-core, checkpoint, judge, dream) | 5 keys | 3 (`extra_checkpoint`, `extra_judge`, `extra_dream`) | 4 |
| **`@sffmc/agentic`** | 4 (max-mode, workflow, compose, health) | 5 keys | 3 (`workflow`, `compose_skill`, `sffmc_health`) | 5 |

Total: 14 sub-features (11 standalone + 3 inner of extra), 12 new skills, 6 tools.

## What's from MiMo-Code vs what's ours

### Ported from MiMo-Code v8.0 (9 features)

| MiMo feature | SFFMC package | MSP | Description |
|---|---|---|---|
| F1 Watchdog | `@sffmc/watchdog` | safety | 3-failure rolling counter + recovery verdict |
| F2 Rules | `@sffmc/rules` | safety | YAML gate-based allow/deny for destructive commands |
| F4' Memory + Recon 8K | `@sffmc/memory` | memory | FTS5 SQLite + context recon at session start |
| F5' Checkpoint | `@sffmc/extra.checkpoint` | memory | 200K resume with schema migration story |
| F6' Judge | `@sffmc/extra.judge` | memory | Multi-criteria verdict with streaming mode |
| F7 Max Mode | `@sffmc/max-mode` | agentic | Parallel drafts + judge (10-20% SWE-Bench gain) |
| F8 Dream | `@sffmc/extra.dream` | memory | LLM cluster naming + memory cleaning |
| W5-6 Dynamic Workflow | `@sffmc/workflow` | agentic | Sandboxed JS (quickjs-emscripten WASM) + 7 builtins |
| W4 Compose | `@sffmc/compose` | agentic | 18 markdown skills (plan, tdd, verify, subagent, etc.) |

### SFFMC team additions (5 packages)

| Package | MSP | Rationale |
|---|---|---|
| `@sffmc/auto-max` | safety | Watchdog/rules-driven auto-escalation to max-mode |
| `@sffmc/eos-stripper` | safety | Local model survival: strip `<\|im_end\|>` etc. from Ollama/vLLM/oMLX outputs |
| `@sffmc/log-whitelist` | safety | Prevents 12GB permission-log spam from 30-day daemon runs |
| `@sffmc/health` | agentic | F3+ plugin diagnostic: 12-check tool with JSON output |
| `@sffmc/shared` | — | SDK: `loadConfig`, `PluginContext`, `EventBus`, `mergeHooks` |

## Quick start

### Option A: Load the 3 MSPs (recommended)

Add to your `~/.config/opencode/opencode.json` `plugin` array:

```json
"file:///path/to/SFFMC/packages/safety/src/index.ts",
"file:///path/to/SFFMC/packages/memory/src/index.ts",
"file:///path/to/SFFMC/packages/agentic/src/index.ts"
```

### Option B: Load individual sub-features (legacy)

All 11 standalone packages still work individually for backward compat:

```json
"file:///path/to/SFFMC/packages/watchdog/src/index.ts",
"file:///path/to/SFFMC/packages/rules/src/index.ts",
"file:///path/to/SFFMC/packages/memory/src/index.ts",
// etc.
```

Verify with `bun run /data/projects/SFFMC/packages/health/src/index.ts` (12 checks).

## What's in v0.9.0

- **3-MSP structure** — safety, memory, agentic compose 14 sub-features via `mergeHooks()`, replacing 11 standalone plugins as the recommended install path
- **mergeHooks** in `@sffmc/shared` — categorizes hooks into TRANSFORM, GATE, SIDE_EFFECT, and tool for collision-free composition
- **12 new skills** — 3 safety, 4 memory, 5 agentic for LLM-facing guidance
- **TRANSFORM hook audit** — 7 handlers across 5 files fixed to return data (chain compat)
- **extra refactor** — 3 named server exports for clean `mergeHooks()` composition
- **memory extracted** — `plugin.ts` (id="memory-core") is the sub-feature; `index.ts` is the MSP wrapper

For the full list, see `CHANGELOG.md`.

## Backward compat

All 11 sub-feature packages still work as standalone plugins. v0.8.2 configs
continue to work without changes. v1.0.0 will deprecate standalone loading
(announced in CHANGELOG when released).

## Repo layout

```
SFFMC/
├── packages/
│   ├── safety/         # NEW in v0.9.0 — MSP: 5 sub-features via mergeHooks
│   ├── memory/         # MSP since v0.9.0 — 4 sub-features (was 1 in v0.8.x)
│   ├── agentic/        # NEW in v0.9.0 — MSP: 4 sub-features via mergeHooks
│   ├── watchdog/       # sub-feature of safety (F1, mimo-port)
│   ├── rules/          # sub-feature of safety (F2, mimo-port)
│   ├── auto-max/       # sub-feature of safety (sffmc-original)
│   ├── eos-stripper/   # sub-feature of safety (sffmc-original)
│   ├── log-whitelist/  # sub-feature of safety (sffmc-original)
│   ├── extra/          # sub-feature of memory (3 inner: checkpoint, judge, dream)
│   ├── max-mode/       # sub-feature of agentic (F7, mimo-port)
│   ├── workflow/       # sub-feature of agentic (W5-6, mimo-port)
│   ├── compose/        # sub-feature of agentic (W4, mimo-port)
│   ├── health/         # sub-feature of agentic (sffmc-original)
│   └── codemap.md      # per-package code map
├── shared/             # @sffmc/shared — loadConfig, PluginContext, EventBus, mergeHooks
├── CHANGELOG.md
├── CONTRIBUTING.md
└── RELEASE.md
```

## Test

```bash
cd /data/projects/SFFMC
bun test                              # 480 tests across 24 files
cd packages/safety && bun test        # 3 tests (MSP smoke)
cd packages/memory && bun test        # 20 tests (3 MSP + 17 DB-layer)
cd packages/agentic && bun test       # 3 tests (MSP smoke)
```

## Contributing

See `CONTRIBUTING.md`. Each sub-feature is a standalone TypeScript module.
MSP packages are thin wrappers that compose sub-features via `mergeHooks()`.

## Publishing

See `RELEASE.md` for the per-package publish checklist (local-only as of v0.9.0).

## Migration from v0.8.x

v0.8.2 configs work without changes. To migrate to MSPs (recommended for new
configs):

```diff
- "plugin": [ ..., "memory", "watchdog", "rules", ..., "max-mode", "compose" ]
+ "plugin": [ ..., "safety", "memory", "agentic" ]
```

The 3 MSPs compose all 11 sub-features via `mergeHooks()` and have no
user-visible behavior change — same hooks, same tools, same configs.
Standalone loading will be deprecated in v1.0.0, not removed.

## License

MIT. See `LICENSE`.
