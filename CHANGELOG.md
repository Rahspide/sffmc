# SFFMC Changelog

## v0.11.1 (2026-06-17)

Post-v0.11.0 cleanup. No API changes.

### Changed

- **Path canonicalization**: `~/.local/share/SFFMC` and `~/.config/SFFMC` auto-rename to lowercase `sffmc` on next plugin load (one-shot, idempotent). All 11 packages updated.
- **Shared logger**: 40+ `console.warn`/`console.log` calls replaced with a shared `createLogger(prefix)` helper across 8 packages (auto-max, eos-stripper, extra, log-whitelist, max-mode, safety, watchdog, workflow).
- **Composite workspace imports**: safety, agentic, and memory composite packages now use `@sffmc/<name>` workspace imports instead of relative paths.
- **Test utilities**: 4 test helpers added to `@sffmc/workflow` (`makeMockCtx`, `makeSlowMockCtx`, `makeCountingMockCtx`, `makeRuntimeWithMockCtx`) in `tests/test-utils.ts`.

## v0.11.0 (2026-06-16)

max-mode and workflow onboarded into `@sffmc/shared`. No API changes for the public `@sffmc/workflow` surface (v0.10.0 breaking interface preserved).

### Added

- **`extractErrorType(output)` and `isToolError(output)`** in `@sffmc/shared` — unified error detection across packages. Replaces auto-max's loose regex with strict pattern matching.
- **`MAX_COMMAND`, `MAX_SUBCOMMANDS`, `MAX_PATTERN`, `MaxSubcommand`** in `@sffmc/shared` — shared `/max` command handling across max-mode, auto-max, and watchdog. Fixes a bug where watchdog missed `/max reset` and `/max clear`.
- **`RichPluginContext`** type in `@sffmc/shared` — extends `PluginContext` with optional `client.session.message()` and `usage.totalTokens`. Replaces separate interfaces in max-mode and workflow.

### Fixed

- **auto-max**: false positive error detection for strings containing "failsafe" or "errorless"
- **watchdog**: `/max reset` and `/max clear` commands were not being recognized

### Changed

- 3 `require()` calls converted to ES module `import` (memory, workflow runtime, workflow persistence)
- Removed redundant `yaml` dependencies from 4 packages (watchdog, auto-max, eos-stripper, log-whitelist)
- Timer hygiene: `.unref()` added to 2 timers to avoid blocking event loop shutdown
- 5 shared states in `@sffmc/extra` (checkpoint buffers, dream lock, timers) converted to on-demand factories — backward-compatible, existing imports preserved
- max-mode and workflow now use `@sffmc/shared` for shared types

### Tests

- 21 new unit tests in `@sffmc/shared` (13 error detection, 8 max-command parsing)
- Total: 510 → 534 tests (+24, includes 3 existing test updates)

## v0.10.1 (2026-06-16)

Post-v0.10.0 cleanup. No API changes — all work preserves v0.10.0 breaking interface.

### Changed

- **builtin-registry**: 7 repeated loader functions collapsed into a single `makeLoader<T>()` helper (90 → 67 lines).
- **workflow runtime** (6 simplifications):
  - `resolveConfig(perStepTimeoutMsOverride?)` — unified config resolution for `start()` and `resume()`
  - `settleEntry` — unified 3 identical `.then().catch()` blocks
  - Removed dead code: unused `writeFile` block in `start()`, vestigial null check in spawnAgent
  - `makeEntry(opts)` — unified triplicated `InternalRunEntry` construction. Fixes 1–2ms drift from duplicate `Date.now()` calls
  - `outcomeFor(entry, status, extras?)` — unified triplicated `WorkflowOutcome` construction

### Fixed

- `PluginContext` import path in workflow integration tests (was pointing to wrong file)

### Tests

- 27 new unit tests for refactored helpers (makeEntry, outcomeFor, resolveConfig, settleEntry, makeLoader)
- Test helpers: `makeSlowMockCtx()` and `makeCountingMockCtx()` added
- Workflow tests: 91 → 102; full suite: 483 → 510

## v0.10.0 (2026-06-16)

### Changed (BREAKING)

**`@sffmc/workflow`**: Singleton chain replaced with injectable classes.
- `WorkflowPersistence` is now a class with optional `db`/`dataDir` injection
- `EventBus` is a `createEventBus()` factory owned by `WorkflowRuntime`
- `WorkspaceJail` is a class
- `runtime-ref.ts` removed
- `WorkflowRuntime.close()` added for lifecycle management

### Performance

- `@sffmc/workflow`: Builtin-registry and `node:fs/promises` imports converted from dynamic to static

### Fixed

- `@sffmc/workflow`: Error logging added in `events.ts` emit catch blocks (was silent)
- Replaced example model names with empty defaults in 6 source files (watchdog, max-mode, extra, auto-max)
- `.slim/deepwork/load-order-audit.json` path renamed to `.sffmc/load-order-audit.json` in loader and health checker
- `.slim/` references scrubbed from 3 source files; `bunfig.toml` no longer ignores `.slim/**`
- Two example config files that escaped v0.9.0 audit now use generic model placeholders

### Added

- **One-liner install**: `curl -fsSL .../install.sh | sh` (Linux/macOS) and `irm .../install.ps1 | iex` (Windows). Clones to `~/.sffmc/plugins/sffmc` and auto-runs init.
- **`sffmc` CLI**: 6 subcommands — `init` (auto-edit `opencode.json` with `--minimal|--all|--only`), `update`, `uninstall`, `doctor` (13-check diagnostic), `path`, `help`.
- `docs/install.md`: Full install guide with troubleshooting.
- README Quick start replaced with one-liner install.

### Documentation

- 8 files updated for v0.10.0 breaking API (removed `setRuntime`/`setJail`/`runtime-ref` references)
- Codemaps for `@sffmc/workflow` rewritten for class-based architecture
- Two missed example model references in `run-max-mode.md` and `judge-output.md` scrubbed

### Migration guide

If you consume `@sffmc/workflow`:
- `WorkflowPersistence.createRun(...)` → `new WorkflowPersistence({ db?: Database, dataDir?: string })` then `.createRun(...)`
- `setRuntime(runtime)` → use `createWorkflowTool(runtime)` directly
- `setJail(root)` → `new WorkflowRuntime(ctx, { workspace: root })`
- All consumers (agentic, memory, safety) updated in this release.

### Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex

# Then
sffmc init              # 3 composites (default)
sffmc init --all        # all 13 packages
sffmc doctor            # 13-check diagnostic
```

## v0.9.1 — Post-release cleanup + bug fixes (2026-06-16)

### Fixed

- **`@sffmc/workflow`**: cancel/fail race in `completeRun` — DB row and `entry.status` could be overwritten to "completed" if a still-pending sandbox `.then()` raced a `cancel()` call.
- **`@sffmc/workflow`**: `events.ts off(key)` was broken for event names containing `_` (all workflow events). Fixed key lookup.
- **`@sffmc/rules`**: `gate.ts isInside()` returned `true` for relative paths like `../etc/passwd`, bypassing safety checks. Fixed to resolve relative paths against project root.

### Documentation fixes

- `docs/getting-started.md`, `docs/migration-from-opencode.md`: updated package and skill counts to match actual (14 packages / 18 skills); added composite-package explanation
- `packages/workflow/README.md`: corrected test count and removed references to nonexistent files
- `docs/migration-from-opencode.md`: corrected hook name and pattern count
- `docs/w5-6-dynamic-workflow.md`: replaced internal references with generic descriptions
- `docs/load-order-audit.md`: replaced internal plugin references with SFFMC-only table
- Multiple source files and docs: replaced example model names with generic `your-model-id`; `.slim/` paths with `.sffmc/`

### Performance

- `@sffmc/extra` (dream): cluster-expansion loop capped at 5 iterations to bound worst-case on large memory DBs

## v0.9.0 — 3-composite restructure: safety, memory, agentic (2026-06-15)

### What's new in v0.9.0

- **3 composite packages** (safety, memory, agentic) replace 14 standalone imports — each composite composes multiple sub-features
- **10 sub-features** can still be used independently as standalone plugins (backward compatible)
- **Drone CI pipeline** with automated npm publish on tags
- **Public release** under `@sffmc/*` on npm

### Breaking changes

- Configs using 10 sub-features: should migrate to 3 composites for new features, but **standalone still works** — no forced migration
- Pre-v0.9.0 localStorage seed format: still compatible (no migration needed)

> Ported from [MiMo-Code v8.0](https://github.com/XiaomiMiMo/MiMo-Code) by Xiaomi. See README for per-feature attribution.

### 3-composite structure

10 sub-features are now composed into 3 composite packages.
The 3 composites use a new `mergeHooks()` utility from `@sffmc/shared` to compose
their sub-features into a single OpenCode plugin entry point.

| Composite | Sub-features | Hooks | Tools | New skills |
|---|---|---|---|---|
| `@sffmc/safety` | watchdog, rules, auto-max, eos-stripper, log-whitelist | 9 keys | 0 | 3 |
| `@sffmc/memory` | memory-core, checkpoint, judge, dream | 5 keys | 3 (extra_*) | 4 |
| `@sffmc/agentic` | max-mode, workflow, compose, health | 5 keys | 3 | 5 |

### New: `@sffmc/shared` exports `mergeHooks()`

`mergeHooks()` composes N `server()` return values into one.
4 hook categories with distinct merge semantics:

- **TRANSFORM** (chain): each handler receives the previous's output
- **GATE** (first-truthy-wins): first handler returning truthy short-circuits
- **SIDE_EFFECT** (sequential): all handlers run, no return value
- **tool** (deep-merge with later-wins + warn on collision)

### TRANSFORM hook audit

7 handlers across 5 packages were returning `void` instead of `data`, which
would break `mergeHooks` TRANSFORM chaining. Fixed in auto-max, eos-stripper,
log-whitelist, max-mode, and watchdog.

### extra refactor (factory → 3 named servers)

`@sffmc/extra` previously bundled 3 sub-features (checkpoint, judge, dream)
via a factory that returned one server. Now exposes 3 named servers:

- `export const checkpointServer` — checkpoint as a composable
- `export const judgeServer` — judge as a composable
- `export const dreamServer` — dream as a composable
- `export const server` — merged (calls all 3 + `mergeHooks()`) for standalone
- `export default { id: "extra", server }` — backward compat

### memory extracted to `plugin.ts` (id="memory-core")

The original 150-line memory implementation moved to `packages/memory/src/plugin.ts`
with `id = "memory-core"`. New `packages/memory/src/index.ts` composes
memory-core + extra's 3 named servers via `mergeHooks()`.

### 12 new skills (3 + 4 + 5)

**Safety (3):**
- `safety:diagnose-tool-failure` — read watchdog's 3-failure verdict
- `safety:write-rule` — add safety rules to `~/.config/SFFMC/rules.yaml`
- `safety:manage-auto-max` — auto-max vs manual `/max`, when to suggest

**Memory (4):**
- `memory:recall` — read auto-injected recon, 5 budget categories
- `memory:checkpoint-save` — 200K token resume point, schema versioning
- `memory:judge-output` — multi-criteria verdict (correctness/readability/performance)
- `memory:dream-cleanup` — 3-phase (cluster/score/archive), restore

**Agentic (5):**
- `agentic:run-workflow` — 7 builtins, QuickJS sandbox limits
- `agentic:run-max-mode` — 3 parallel candidates + 1 judge, cost awareness
- `agentic:compose-skill` — index of 18 compose skills
- `agentic:health-check` — 12 sffmc_health checks
- `agentic:resolve-hook-conflict` — TRANSFORM/GATE/SIDE_EFFECT semantics

### Migration from v0.8.2

v0.8.2 configs work without changes — all 10 sub-feature packages still
load as standalone plugins. To use the new composites (recommended):

```diff
- "plugin": [ ..., "memory", "watchdog", "rules", "max-mode", "compose", ... ]
+ "plugin": [ ..., "safety", "memory", "agentic" ]
```

The 3 composites compose all 10 sub-features via `mergeHooks()` and have no
user-visible behavior change. Same hooks, same tools, same YAML configs.

## v0.8.2 — Package categories (mimo-port vs sffmc-original) (2026-06-15)

## Package categories
Each of the 11 SFFMC packages now has explicit `category` metadata in
`package.json` to clearly separate features ported from MiMo-Code v8.0
from SFFMC team additions.
### mimo-port (7 packages — ported from MiMo-Code v8.0)
- @sffmc/memory (F4' Memory + Context Recon)
- @sffmc/rules (F2 Safety Rules)
- @sffmc/watchdog (F1 Auto-recovery)
- @sffmc/max-mode (F7 Parallel drafts)
- @sffmc/auto-max (Auto-escalation)
- @sffmc/compose (15 MiMo compose skills)
- @sffmc/workflow (W5-6 Dynamic Workflow)
### sffmc-original (4 packages — SFFMC team additions)
- @sffmc/eos-stripper (local model EOS token survival)
- @sffmc/log-whitelist (12GB log file prevention)
- @sffmc/health (plugin-author diagnostic)
- @sffmc/extra (F5'/F6'/F8 opt-in bundle)
## sffmc_health new check
12th check `category_split` reports the split and warns if any package
is uncategorized. Currently 7 mimo-port + 4 sffmc-original, 0 uncategorized.
Full sffmc_health: 12 ok, 0 warn, 0 fail (was 11 ok 1 warn in v0.8.1
due to changelog_currency mismatch — fixed by version bump).
## Docs
- README.md: new "Package categories" section with full table
- Each package.json: `category` field + `portSource` (mimo-port) or
  `rationale` (sffmc-original)
## Version sync
All 13 packages (11 SFFMC + shared + root) bumped 0.8.0 → 0.8.1 to
align with CHANGELOG v0.8.1 (was inconsistent in v0.8.1 release).

## v0.8.1 — Known gaps fixed + F5'/F6'/F8 enhancements + 6 new skills/builtins (2026-06-15)

### Fixed

- **compose**: graceful error on corrupted/missing skill file
- **auto-max**: 3 improvements
  - `dry_run: boolean` config — counts failures but doesn't actually trigger max-mode
  - `/max` escape hatch hook (regex matches `/max`, `/max reset`, `/max clear`, `/max reset <id>`)
  - Object output error detection — `{ error }` or `{ code }` fields now counted as failures

### Added

**F5'/F6'/F8 enhancements:**
- **F5' Checkpoint**: schema migration — `CURRENT_VERSION=1`, `migrateCheckpoint(raw, fromVersion)`, forward-compat restore
- **F6' Judge**: streaming mode — `callJudgeStream` with `onChunk` callback for `scores`/`winner`/`reasoning`/`complete`/`error` chunks
- **F8 Dream**: LLM cluster naming — `nameClusterViaLLM` generates 3-5 word topic phrase

**New workflow builtins (3):**
- `security-audit` (4 phases): Scope → Scan (4 parallel agents) → Triage → Report
- `doc-gen` (3 phases): Inventory → Generate (parallel batches) → Assemble
- `lib-migrate` (5 phases): Detect → Map → Transform → Verify → Report
- 7 builtins total (was 4)

**New compose skills (3):**
- `code-review` (6.7KB): structured review with severity-tagged findings
- `benchmark` (7.2KB): perf measurement + baseline comparison
- `audit-deps` (8.7KB): outdated/vuln/unused/license audit
- 18 skills total (was 15)

### Changed

- auto-max, watchdog: migrated to shared config loader (`loadConfig`)

### Tests

- 429 → 465 tests (+36)

## v0.8.0 — @sffmc/extra plugin (F5'/F6'/F8 opt-in bundle) (2026-06-15)

### Added

New `@sffmc/extra` plugin: opt-in bundle of 3 advanced features.
All features disabled by default — toggle per feature via config flags.

**F5' Checkpoint** (`extra_checkpoint` tool):
- Captures every `tool.execute.after` call into per-session JSONL at
  `~/.local/share/sffmc/extra/checkpoints/<sessionID>.jsonl` (configurable via `checkpoint_dir`)
- Schema versioning: `version: 1` header, restore rejects unknown versions
- Actions: `list` (show sessions), `restore` (reconstruct messages), `delete` (remove)
- Auto-restore via `<!-- EXTRA_RESTORE: <sessionID> -->` marker in messages
- Append-only JSONL for crash safety

**F6' Judge** (`extra_judge` tool):
- LLM judge scoring 2-8 candidate outputs
- Multi-criteria rubric: correctness, completeness, conciseness (0-10 each)
- Returns `{ scores, winner, reasoning, model, latencyMs }`
- Configurable model (default `your-model-id`) + rubric
- `judge_auto` flag: auto-judge candidates marked with `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->`
- LLM call at temperature 0.2 for determinism
- JSON parsing with validation (rejects malformed responses)

**F8 Dream** (`extra_dream` tool):
- 3 trigger paths: count > threshold (default 50), cron interval (default 24h), manual
- Dedup: Jaccard similarity > 0.9, keep newer entry by `last_accessed`
- Stale removal: `last_accessed > 30 days` → archived to `dream-archive.jsonl`
- Cluster summarization: Jaccard > 0.3 cluster, 5+ entries → LLM summary
- Concurrency: Promise-lock prevents overlapping runs
- LLM summarization with graceful fallback to concat on error

### Tests

- 29 new tests across 3 packages (compose, eos-stripper, auto-max)
- 429 tests pass (was 394)
- All packages bumped to v0.8.0

### Migration from v0.7.5

No breaking changes. To opt in to F5'/F6'/F8, add to `~/.config/SFFMC/extra.yaml`:
```yaml
checkpoint: true      # F5' capture + restore
judge: true           # F6' multi-criteria LLM scoring
dream: true           # F8 background memory cleaner
checkpoint_dir: ""    # default ~/.local/share/sffmc/extra/checkpoints/
dream_threshold: 50   # count > N triggers dream
dream_interval_hours: 24
judge_model: "your-model-id"
judge_auto: false     # auto-judge markers in messages
```

## v0.7.5 — Full repository codemap (2026-06-15)

### Added

- **Repository codemap**: 24 `codemap.md` files (~11,000 words total) covering every package and source directory
- `codemap.md` (root) — master entry point with directory map
- `packages/codemap.md` (umbrella) — 10 plugins + shared SDK overview
- 10 × `packages/<plugin>/codemap.md` — package-level architecture
- 10 × `packages/<plugin>/src/codemap.md` — file-by-file breakdown
- `shared/codemap.md` + `shared/src/codemap.md` — SDK architecture
- `AGENTS.md` — auto-load entry with Repository Map section

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

### Tests

292 tests pass

## v0.7.4 — Shared SDK migration + test output cleanup (2026-06-15)

### Changed

- 3 additional plugins migrated to `@sffmc/shared` (`PluginContext` + `loadConfig`): `@sffmc/rules`, `@sffmc/auto-max`, `@sffmc/watchdog`
- `@sffmc/compose` and `@sffmc/memory` also updated
- Test output: reduced noisy `[watchdog] loaded` / `[auto-max] loaded` logs from 8 lines to 2 per test run

### Tests

292 tests pass

## v0.7.3 — Test infrastructure hardening (2026-06-15)

### Added

- **Pre-commit hook** (`.git/hooks/pre-commit`): runs `bun test` + typecheck + load-order audit + health check. Bypass with `git commit --no-verify`.
- **`bun run test:watch`**: re-runs all tests on every `.ts` save
- **`scripts/run-health.ts`**: CLI invocation script for `@sffmc/health`
- **`bun run typecheck`**: now uses `bun build --no-bundle` (Bun-native, no external `tsc` required)

### Changed

- `@sffmc/health` now loaded in development sandbox — LLM can call `sffmc_health` tool in sandbox sessions
- `.sffmc/` added to `.gitignore` (workflow runtime artifacts)

### Fixed

- Pre-commit hook: fixed exit code handling (was piping through `tail` which masked failures)

### Documentation

- `docs/examples/migrate-7-plugins-to-shared.json` — example plan artifact

### Tests

- 272 → 292 tests (+20 from `@sffmc/health`)

## v0.7.2 — F3+ Health plugin (2026-06-15)

Revived F3+ Health as a real diagnostic tool. Plugin authors can now run `sffmc_health` to check monorepo health in <1s.

### New package: `@sffmc/health`

- Exposes one LLM-callable tool `sffmc_health` returning JSON.
- 7 diagnostic checks:
  1. `hook_conflicts` — 0 real conflicts across 9 plugins
  2. `test_presence` — every package must have `*.test.ts`
  3. `readme_presence` — every package must have `README.md`
  4. `type_check` — `bun build --no-bundle` per plugin
  5. `tool_registration` — prevents a known tool registration regression
  6. `version_consistency` — root version matches all plugins
  7. `license` — LICENSE present + every README references it
- Each check returns `ok | warn | fail` with human-readable detail.
- Top-level `ok` is `false` if any check fails.

### Other changes

- `shared/README.md` — created (caught by `sffmc_health`'s first run)
- `bun run test:watch` — re-runs tests on every `.ts` save

### Tests

- 272 → 292 (+20 from `health`)

## v0.7.0 — Workflow builtins + shared SDK + docs (2026-06-15)

4 user-facing features, ~1500 LOC, 102 tests pass.

### New workflow builtins (`@sffmc/workflow`)

- `plan` — 4-phase structured planning (Scope → Decompose → Estimate → Output). Takes `args.goal`, returns scope clarification, success criteria, ordered steps with deps, est_minutes, parallel_group. Self-retries on under-decomposed output.
- `tdd` — 5-phase TDD-style artifact generation (Spec → Red → Green → Refactor → Verify). Takes `args.feature`, returns test file + impl file + refactor notes as artifacts. Generates, does NOT execute (LLM-only).
- `refactor` — 4-phase refactor proposer (Scan → Diagnose → Propose → Output). Reads files via workspace primitives, lists 3-7 smells, returns 1-5 before/after patches with risk levels. Does NOT auto-apply (advisory).

`deep-research` builtin still ships (now 4 builtins total).

### New package: `@sffmc/shared`

- `loadConfig<T>(pluginName, defaults, opts?)` — YAML config loader merging `~/.config/SFFMC/<name>.yaml` over defaults. Never throws.
- `PluginContext` interface — single canonical type for all plugins.
- `on` / `off` / `emit` / `clearAll` — generic type-safe EventBus (extracted from workflow's events).

**Refactored**: `eos-stripper`, `log-whitelist` now use `@sffmc/shared`.

### Per-plugin READMEs (9 packages)

Each `packages/<pkg>/README.md` now has: header, one-line purpose, install snippet, config YAML excerpt, hook table, test command, MIT footer.

### Getting-started guide

`docs/getting-started.md` (7 sections): What is SFFMC → Prerequisites → Install → Your first workflow (deep-research) → Save a custom workflow → Debugging → Next steps.

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
- `scripts/audit-load-order.py` — reusable AST-based hook auditor
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
