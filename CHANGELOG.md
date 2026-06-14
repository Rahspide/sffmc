# SFFMC Changelog

## v0.7.0 — Workflow builtins + shared SDK + docs (2026-06-15)

4 user-facing features, ~1500 LOC, 102/102 tests pass.

### New workflow builtins (`@sffmc/workflow`)

- `plan` — 4-phase structured planning (Scope → Decompose → Estimate → Output). Takes `args.goal`, returns scope clarification, success criteria, ordered steps with deps, est_minutes, parallel_group. Self-retries on under-decomposed output.
- `tdd` — 5-phase TDD-style artifact generation (Spec → Red → Green → Refactor → Verify). Takes `args.feature`, returns test file + impl file + refactor notes as artifacts. Generates, does NOT execute (LLM-only).
- `refactor` — 4-phase refactor proposer (Scan → Diagnose → Propose → Output). Reads files via workspace primitives, lists 3-7 smells, returns 1-5 before/after patches with risk levels. Does NOT auto-apply (advisory).

`deep-research` builtin still ships (now 4 builtins total).

### New package: `@sffmc/shared`

- `loadConfig<T>(pluginName, defaults, opts?)` — YAML config loader merging `~/.config/SFFMC/<name>.yaml` over defaults. Never throws.
- `PluginContext` interface — single canonical type for all plugins.
- `on` / `off` / `emit` / `clearAll` — generic type-safe EventBus (extracted from workflow's events).

**Refactored**: `eos-stripper`, `log-whitelist` now use `@sffmc/shared` (proof of concept; other plugins can adopt incrementally).

8 tests in the new package (4 config, 4 events).

### Per-plugin READMEs (9 packages)

Each `packages/<pkg>/README.md` now has: header, one-line purpose (from CHANGELOG v0.6.0 verbatim), install snippet, config YAML excerpt, hook table (from `docs/load-order-audit.md`), test command, MIT footer. Total 563 LOC.

### Getting-started guide

`docs/getting-started.md` (179 lines, 7 sections): What is SFFMC → Prerequisites → Install → Your first workflow (deep-research) → Save a custom workflow → Debugging → Next steps. Internal links use relative paths. Code blocks have language tags.

### Tests

| Package | Before | After |
|---|---|---|
| workflow | 96 | 102 (+6: plan/tdd/refactor registration + load tests) |
| shared | 0 | 8 (4 config + 4 events) |
| All others | 152 | 152 (no regressions) |
| **Total** | **248** | **266** (+18) |

## v0.6.1 — Load order audit (2026-06-15)

Post-release patch:
- `docs/load-order-audit.md` — full audit of 9 SFFMC plugin hooks, 0 conflicts found
- `scripts/audit-load-order.py` — reusable AST-based hook auditor (for v0.7.0+ CI)
- All critical sequences verified: /max reset→activate, watchdog→log-whitelist→auto-max output chain, eos-stripper→log-whitelist text chain
- Tool names: only `compose_skill` (compose) and `workflow` (workflow) — no conflicts

No code changes. No plugin version bumps. Pure docs + tooling.

## v0.6.0 — Dynamic Workflow engine (2026-06-14)

9 SFFMC plugins shipped:
- @sffmc/memory (W1) — FTS5 + ICM extraction
- @sffmc/rules (W1) — YAML gate-based allow/deny
- @sffmc/watchdog (W2) — 3-failure counter, auto-recovery
- @sffmc/eos-stripper (W2) — EOS token cleanup
- @sffmc/log-whitelist (W2) — agent log filter
- @sffmc/max-mode (W3) — parallel drafts + judge
- @sffmc/auto-max (W3) — auto-escalation to max-mode
- @sffmc/compose (W4) — 15 compose skills
- @sffmc/workflow (W5-6) — NEW

Workflow engine:
- Sandboxed JavaScript via quickjs-emscripten WASM
- 3 primitives: agent(), parallel(), pipeline()
- 5-layer budget: lifecycle 1000, concurrent 16, depth 8, wall-clock 12h, token 2M
- 3-layer state: SQLite row + per-run script + JSONL journal
- Resume from crash (SHA-256 edit detection)
- Canonical example: deep-research (6 phases, adversarial jury)
- 96+ tests passing

## v0.5.0 — Compose skills (2026-06-14)

- @sffmc/compose: compose_skill tool, 15 skills from MiMo-Code
- Plan, TDD, verify, subagent, and 11 other structured workflows

## v0.4.0 — Max Mode + Auto-max (2026-06-14)

- @sffmc/max-mode: schema-only tools trick, 3 candidates + judge
- @sffmc/auto-max: auto-escalation from watchdog triggers

## v0.3.0 — Watchdog + Strippers (2026-06-14)

- @sffmc/watchdog: 3-failure counter, auto-max trigger, recovery verdict
- @sffmc/eos-stripper: EOS token removal
- @sffmc/log-whitelist: configurable log filter

## v0.2.0 — Foundation (2026-06-14)

- @sffmc/memory: FTS5 full-text search, ICM extraction
- @sffmc/rules: YAML hot-reload, gate-based tool filtering

## v0.1.0 — Scaffold (2026-06-14)

- Monorepo setup: bun workspace, tsconfig, .gitignore, LICENSE
- README, docs/ (import-from-mimo.md, migration-from-opencode.md, v8-decision.md)
