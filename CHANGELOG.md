# SFFMC Changelog

## v0.7.5 — Full repository codemap (2026-06-15)

Generated via Codemap skill. 11 parallel fixer agents + orchestrator umbrella + root atlas.

### Files written (24 codemap.md + 1 atlas)

- `codemap.md` (root) — 1380 words, master entry point with directory map
- `packages/codemap.md` (umbrella) — 1415 words, 10 plugins + shared SDK overview
- 10 × `packages/<plugin>/codemap.md` — package-level architecture per plugin
- 10 × `packages/<plugin>/src/codemap.md` — file-by-file breakdown per plugin
- 2 × `shared/codemap.md` + `shared/src/codemap.md` — SDK architecture
- `AGENTS.md` — auto-load entry with Repository Map section
- `.slim/codemap.json` — change-detection state (56 files tracked)

**Total: ~11000 words across 24 codemap.md files**

### Plugin codemap word counts

| Plugin | Package | src | Total |
|---|---|---|---|
| memory | 954 | 1187 | 2141 |
| rules | 585 | 730 | 1315 |
| watchdog | 535 | 714 | 1249 |
| eos-stripper | 501 | 547 | 1048 |
| log-whitelist | 475 | 415 | 890 |
| max-mode | 888 | 929 | 1817 |
| auto-max | 802 | 546 | 1348 |
| compose | 755 | 652 | 1407 |
| workflow | 1604 | 2266 | 3870 |
| health | 766 | 516 | 1282 |
| shared | 426 | 653 | 1079 |

### Verification
- 292/292 tests pass
- sffmc_health 7/7 ok
- pre-commit hook (4-gate) clean
- bunfig.toml scopes test discovery correctly

## v0.7.4 — Shared SDK migration + test log cleanup (2026-06-15)

Two parallel cleanups: increase shared SDK adoption and silence noisy test output.

### Shared SDK adoption: 3/10 → 6/10 plugins

Migrated local `PluginContext` interfaces to `@sffmc/shared`:
- `@sffmc/memory` — was already importing `loadConfig` but had no `workspace:*` dep declaration
- `@sffmc/rules`
- `@sffmc/auto-max`
- `@sffmc/watchdog`
- `@sffmc/compose`

`@sffmc/max-mode` keeps its local interface (has complex `sessionID?` / `client?.session?.message?` types not in shared).
`@sffmc/workflow` already had its own type from `runtime.ts`.

Each migrated package.json now declares `"@sffmc/shared": "workspace:*"`. Lockfile updated via `bun install`.

### Test log cleanup (subagent-verified)

`bun test` output was 4× noisy per test run. Two plugins had `console.warn(...loaded...)` inside `server()`, firing once per test file that imported the plugin:
- `c344025` — `@sffmc/watchdog`: `let loadedLogged = false` flag gates the warn
- `8440834` — `@sffmc/auto-max`: same pattern

**Before**: 4 `[watchdog] loaded` + 4 `[auto-max] loaded` = 8 lines of noise per test run
**After**: 1 + 1 = 2 lines

Both fixes verified by subagent `ses_1374532f8ffe352UPSZ5ryFdy9` (watchdog) and `ses_1373e4e76ffec2wZy4JYi4U3Kh` (auto-max). 292/292 tests pass, sffmc_health 7/7.

## v0.7.3 — Test infrastructure hardening (2026-06-15)

User asked to tighten testing infrastructure before going to prod. This release makes every commit verified.

### Test infra (3 new scripts + 1 hook upgrade)

- **Pre-commit hook** (`.git/hooks/pre-commit`) now runs 4 gates: `bun test` + `bun run typecheck` + `python3 scripts/audit-load-order.py` + `bun run scripts/run-health.ts`. Bypass with `git commit --no-verify`. Smoke-tested 3× today, all green.
- **`bun run test:watch`** — added to root `package.json`. Bun's built-in `--watch` re-runs all 272 tests on every `.ts` save. User can keep a terminal open and see red/green in real-time.
- **`scripts/run-health.ts`** — invocation script for `@sffmc/health`. Runs all 7 checks against the SFFMC repo in ~1s, prints JSON. Wired into pre-commit hook.
- **`bun run typecheck`** — fixed. Was `tsc --noEmit` (global tsc required, broken). Now uses `bun build --no-bundle` (Bun-native, no extra deps).

### @sffmc/health now loaded in sandbox

Added `file:///data/projects/SFFMC/packages/health/src/index.ts` to sandbox :4200 config. Restart verified: 10/10 SFFMC plugins loaded, 0 errors. LLM can now call `sffmc_health` tool in sandbox sessions.

### Example plan artifact

`docs/examples/migrate-7-plugins-to-shared.json` — a 14-step plan for migrating the remaining 7 plugins to `@sffmc/shared`. Generated as if by the `plan` workflow builtin (LLM-computed, structured per `plan.ts` schema). 5 audit steps in parallel, 5 migrations in parallel, 2 verify steps, 1 docs, 1 release. Total 290 min, bottleneck is watchdog's model-fallback edge case.

### Gitignore

Added `.sffmc/` (per-project workflow runtime artifacts, like `.slim/deepwork/`).

### Tests
- 272 → 292 (added 20 in @sffmc/health in v0.7.2)
- All green via pre-commit hook

### Bug fix in pre-commit hook (post-release)
- Hook was using `bun test` (default, includes `dependencies/MiMo-Code` → 355 fake failures) AND piping through `| tail` which masked exit codes
- Fixed: use scoped `bun test --path-ignore-patterns='dependencies/**' packages/ shared/` + verify exit code explicitly via `|| { ... exit 1 }`
- Hook now correctly fails the commit on real test failures

## v0.7.2 — F3+ Health plugin (2026-06-15)

Revived F3+ Health from v8.0 cut list (`docs/v8-decision.md`) as a real diagnostic tool. Plugin authors can now run `sffmc_health` to check monorepo health in <1s.

### New package: `@sffmc/health`

- Exposes one LLM-callable tool `sffmc_health` returning JSON.
- 7 diagnostic checks:
  1. `hook_conflicts` — 0 real conflicts across 9 plugins (reuses `audit-load-order.py` logic)
  2. `test_presence` — every package must have `*.test.ts`
  3. `readme_presence` — every package must have `README.md`
  4. `type_check` — `bun build --no-bundle` per plugin
  5. `tool_registration` — no `name:` field inside tool defs (regression for fix-17)
  6. `version_consistency` — root version matches all plugins
  7. `license` — LICENSE present + every README references it
- Each check returns `ok | warn | fail` with human-readable detail.
- Top-level `ok` is `false` if any check fails.

### Other changes

- `shared/README.md` — created (caught by `sffmc_health`'s first run; closed by this release)
- Pre-commit hook: runs `bun test` + `bun run typecheck` + `python3 scripts/audit-load-order.py` automatically
- `bun run test:watch` — bun's built-in watch mode re-runs tests on every `.ts` save

### Tests

- 272 → 292 (+20 from `health`)
- `sffmc_health` self-tested: live output 7/7 ok against the current repo

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
