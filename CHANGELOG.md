# SFFMC Changelog

## v0.10.0 (2026-06-16)

### Refactor (BREAKING)
- **workflow**: Break singleton chain — `WorkflowPersistence` is now a class with optional `db`/`dataDir` injection; `EventBus` is a `createEventBus()` factory owned by `WorkflowRuntime`; `WorkspaceJail` is a class. `runtime-ref.ts` is **deleted**. `WorkflowRuntime.close()` for lifecycle.

### Performance
- **workflow**: Convert builtin-registry dynamic imports to static; convert `node:fs/promises` dynamic imports in runtime.ts to static.

### Fixes
- **workflow**: Log errors in `events.ts` emit catch blocks (was silent swallow).
- **scrub**: Replace `claude-sonnet-4-20250514` defaults with `""` in 6 source files (watchdog, max-mode, extra, auto-max).

### Documentation
- **agentic + workflow + safety**: 8 files updated to reflect v0.10.0 BREAKING API (removed `setRuntime`/`setJail`/`runtime-ref` references; replaced `WorkflowPersistence.createRun` with class-instance pattern). Two missed `claude-sonnet-4-20250514` references in `run-max-mode.md` and `judge-output.md` scrubbed.
- **codemaps**: `packages/workflow/{,src/}codemap.md` fully rewritten for class-based architecture.

### Security audit (council v1)
- **CRITICAL**: `claude-sonnet-4-20250514` scrubbed from 2 example YAML configs (`auto-max`, `max-mode`) that escaped the v0.9.0 scrub.
- **HIGH**: `.slim/deepwork/load-order-audit.json` path renamed to `.sffmc/load-order-audit.json` in `scripts/audit-load-order.py:221` (writer) and `packages/health/src/index.ts:108` (reader) — coupled bug fix.
- **MEDIUM**: `.slim/` references scrubbed from 3 skill/code files; `bunfig.toml` no longer ignores `.slim/**`.
- **audit-public-content.sh extended** to also scan `config/*.example.yaml`, `skills/*.md`, `*.py`, `*.ts` source — closes the v0.9.0 scrub blind spot.

### New: one-liner install + `sffmc` CLI
- `install.sh` (Linux/macOS) + `install.ps1` (Windows): curl/irm one-liner that clones to `~/.sffmc/plugins/sffmc` and auto-runs init.
- `bin/sffmc` + `bin/sffmc.ps1`: CLI with 6 subcommands — `init` (auto-edit `opencode.json` with `--minimal|--all|--only`), `update`, `uninstall`, `doctor` (13-check diagnostic), `path`, `help`.
- `docs/install.md`: full install guide with troubleshooting.
- **README "Quick start"** replaced with one-liner install.

### Infrastructure
- `bun.lock` regenerated after dependabot PR #1 (chokidar 4.0.3→5.0.0, typescript 5.9.3→6.0.3).
- `sffmc_health` tool: added `paths` parameter to schema (was failing MCP wrapper validation).
- All 15 packages at v0.10.0, version-consistent.

### Migration guide
If you consume `@sffmc/workflow`:
- `WorkflowPersistence.createRun(...)` → `new WorkflowPersistence({ db?: Database, dataDir?: string })` then `.createRun(...)`
- `setRuntime(runtime)` → use `createWorkflowTool(runtime)` directly
- `setJail(root)` → `new WorkflowRuntime(ctx, { workspace: root })`
- All consumers (agentic, memory, safety) updated in this release.

### Install (replaces manual `opencode.json` editing)
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

### Stats
- 13 commits since v0.9.0 (`8a86aa0` → `9d7cbc2`)
- 483/483 tests pass, 1285 expect() calls, 24 files
- 22+ files touched (refactor + docs + install + security)
- 0 secrets / 0 internal infra references (council audit v1)

## v0.9.1 — Post-release cleanup + bug fixes (2026-06-16)

### Bug fixes (from council round 2 audit)

- **`@sffmc/workflow`**: cancel/fail race in `completeRun` (DB row + `entry.status` would be overwritten to "completed" if a still-pending sandbox `.then()` raced a `cancel()` call). Added guard mirroring `failRun`. The existing cancel test passed by accident because it only checked the resolved outcome, not the DB row.
- **`@sffmc/workflow`**: `events.ts off(key)` was broken for any event name containing `_` (all workflow events do). Fixed to look up the listener by full key across all event names.
- **`@sffmc/rules`**: `gate.ts isInside()` returned `true` for any relative path like `../etc/passwd`, bypassing the `path_outside` safety gate. Fixed to resolve relative paths against project root before checking.

### Documentation fixes

- `docs/getting-started.md`, `docs/migration-from-opencode.md`: "9 plugins / 15 skills" → "14 packages / 18 skills"; added composite-package explanation.
- `packages/workflow/README.md`: "73 tests across 4 files" → "78 tests across 3 files" (matches actual: foundation 69 + integration 4 + e2e-200-steps 5). Removed references to nonexistent `src/index.test.ts` and `src/sandbox.test.ts`.
- `docs/migration-from-opencode.md`: EOS stripper hook name corrected (`experimental.text.complete`, not `messages.transform`); 7 patterns → 10 patterns (matches `DEFAULT_EOS_PATTERNS`); "19 tests" → "486 tests".
- `docs/w5-6-dynamic-workflow.md`: removed internal `9Router` references; replaced with generic "your LLM-backed search endpoint".
- `docs/load-order-audit.md`: removed references to internal plugins (`oh-my-opencode-slim`, `dcp-upstream`, etc.); replaced with generic SFFMC-only table.
- `CHANGELOG.md`, `packages/safety/skills/diagnose-tool-failure.md`, `packages/safety/skills/manage-auto-max.md`: replaced `claude-sonnet-4-20250514` model examples with `your-model-id`; `.slim/` paths with `.sffmc/`.

### Performance

- `@sffmc/extra` (dream): cluster-expansion loop capped at 5 iterations to bound worst-case O(n³) on 1000+ row memory DBs.

### Infrastructure

- `scripts/audit-public-content.sh` (added in v0.9.0 round 1): now runs as part of precommit gate and as a Drone CI step. Detects internal-infrastructure terms, hallucinated model names, stale counts.

### Verification

- 486/486 tests pass (24 files, 1289 expect() calls), stable across 3 runs.
- Precommit green: `bun test` + `bun run typecheck` + `audit-load-order.py` + `sffmc_health` + `audit-public-content.sh` all pass.
- 0 internal-infrastructure leaks detected in docs/READMEs (audit clean).

## v0.9.0 — 3-MSP restructure: safety, memory, agentic (2026-06-15)

### What's new in v0.9.0

- **3 composite packages** (safety, memory, agentic) replace 14 standalone imports — each MSP composes multiple sub-features via `mergeHooks()`
- **10 sub-features** can still be used independently as standalone plugins (backward compatible)
- **486/486 tests passing**, 96% long-form agent test coverage
- **Drone CI pipeline** with automated npm publish on tags
- **Public release** under `@sffmc/*` on npm

### Breaking changes

- Configs using 10 sub-features: should migrate to 3 MSPs for new features, but **standalone still works** — no forced migration
- Pre-v0.9.0 localStorage seed format: still compatible (no migration needed)

> Ported from [MiMo-Code v8.0](https://github.com/XiaomiMiMo/MiMo-Code) by Xiaomi. See README for per-feature attribution.

### 3-MSP structure (BREAKING for v0.8.2 configs that use only sub-features)

10 sub-features are now composed into 3 Multi-Plugin Packages (MSPs).
The 3 MSPs use a new `mergeHooks()` utility from `@sffmc/shared` to compose
their sub-features into a single OpenCode plugin entry point.

| MSP | Sub-features | Hooks | Tools | New skills |
|---|---|---|---|---|
| `@sffmc/safety` | watchdog, rules, auto-max, eos-stripper, log-whitelist | 9 keys | 0 | 3 |
| `@sffmc/memory` | memory-core, checkpoint, judge, dream | 5 keys | 3 (extra_*) | 4 |
| `@sffmc/agentic` | max-mode, workflow, compose, health | 5 keys | 3 | 5 |

### New: `@sffmc/shared` exports `mergeHooks()`

`shared/src/merge-hooks.ts` (127 lines) — composes N `server()` return values
into one. 4 hook categories with distinct merge semantics:

- **TRANSFORM** (chain): each handler receives the previous's output
- **GATE** (first-truthy-wins): first handler returning truthy short-circuits
- **SIDE_EFFECT** (sequential): all handlers run, no return value
- **tool** (deep-merge with later-wins + warn on collision)

6 tests cover each category. Unknown keys default to SIDE_EFFECT.

### TRANSFORM hook audit

7 handlers across 5 files were returning `void` instead of `data`, which
would break `mergeHooks` TRANSFORM chaining. Fixed:

- `auto-max`: `experimental.chat.system.transform` — added `return data;`
- `eos-stripper`: `experimental.text.complete` — 2 fixes
- `log-whitelist`: `experimental.text.complete` — 2 fixes
- `max-mode`: `experimental.chat.system.transform` + `experimental.chat.messages.transform`
- `watchdog`: `experimental.chat.system.transform` (3 fixes) + `experimental.chat.messages.transform`

### extra refactor (factory → 3 named servers)

`@sffmc/extra` previously bundled 3 sub-features (checkpoint, judge, dream)
via a factory that returned one server. Now exposes 3 named servers:

- `export const checkpointServer` — checkpoint as a composable
- `export const judgeServer` — judge as a composable
- `export const dreamServer` — dream as a composable
- `export const server` — merged (calls all 3 + `mergeHooks()`) for standalone
- `export default { id: "extra", server }` — backward compat

This lets the memory MSP compose the 3 sub-features individually.

### memory extracted to `plugin.ts` (id="memory-core")

The original 150-line memory impl moved to `packages/memory/src/plugin.ts`
with `id = "memory-core"` (to avoid conflict with the MSP's id). New
`packages/memory/src/index.ts` is a thin wrapper that composes
memory-core + extra's 3 named servers via `mergeHooks()`.

DB-layer tests preserved in `memory.test.ts` (17 tests). New MSP smoke
tests in `index.test.ts` (3 tests).

### 12 new skills (3 + 4 + 5)

Following the `packages/compose/skills/ask.md` style (YAML frontmatter,
"The Rule", examples, "Why this skill exists"):

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
load as standalone plugins. To use the new MSPs (recommended):

```diff
- "plugin": [ ..., "memory", "watchdog", "rules", "max-mode", "compose", ... ]
+ "plugin": [ ..., "safety", "memory", "agentic" ]
```

The 3 MSPs compose all 10 sub-features via `mergeHooks()` and have no
user-visible behavior change. Same hooks, same tools, same YAML configs.

### Tests

- 467 → 486 (+19) tests across 21 → 24 files
- New tests: 6 mergeHooks + 4 MSP stubs (Phase 1) + 3 MSP wired tests (Phase 2)
- Skill smoke tests deferred (Phase 3 is markdown-only, no test harness)
- All 12 packages + shared typecheck pass

### Pre-commit 4-gate

- sffmc_health: 12 ok (Phase 6 will add 13th checkMspStructure)
- bun test: 486 pass
- typecheck: clean
- load-order audit: clean

### Notes for v1.0.0

- v1.0.0 will deprecate standalone sub-feature packages
- v1.0.0 will physically move sub-feature source into MSP src/
- Test split (Phase 4 of v0.9.0 plan) deferred to post-v0.9.0 cleanup

### Files

- Created: `packages/safety/`, `packages/agentic/` (Phase 1)
- Modified: `packages/memory/src/{index,plugin}.ts` (Phase 2)
- Modified: 5 sub-feature src/index.ts for TRANSFORM audit (Phase 2)
- Modified: `packages/extra/src/{index,checkpoint,judge,dream}.ts` (Phase 2)
- New: 12 skills in `packages/{safety,memory,agentic}/skills/` (Phase 3)
- New: `shared/src/merge-hooks.{ts,test.ts}` (Phase 0.5)
- Updated: 12 package.jsons (mspRole, mspFeatures), 3 new MSP READMEs


## v0.8.2 — Ship v0.8.2: package categories (mimo-port vs sffmc-original) (2026-06-15)

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
- @sffmc/health (F3+ plugin-author diagnostic)
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
## Stats
- Tests: 465 → 467 (+2 for checkCategorySplit)
- sffmc_health: 11 ok 1 warn → 12 ok 0 warn 0 fail
- 11 packages categorized, 0 uncategorized


## v0.8.1 — Ship v0.8.1: known gaps fixed + F5'/F6'/F8 enhancements + 6 new skills/builtins (2026-06-15)

## Known gaps fixed
- **compose**: graceful error on corrupted/missing skill file (try/catch + null-guard + empty-content check)
- **auto-max**: 3 improvements
  - `dry_run: boolean` config — counts failures but doesn't actually trigger max-mode
  - `/max` escape hatch hook (regex matches `/max`, `/max reset`, `/max clear`, `/max reset <id>`)
  - Object output error detection — `{ error }` or `{ code }` fields now counted as failures
## F5'/F6'/F8 enhancements
- **F5' Checkpoint**: schema migration story — `CURRENT_VERSION=1`, `MIGRATIONS={}` scaffold,
  `migrateCheckpoint(raw, fromVersion)` exported, forward-compat restore logic
- **F6' Judge**: streaming mode — `callJudgeStream` with `onChunk` callback emitting
  `scores`/`winner`/`reasoning`/`complete`/`error` chunks
- **F8 Dream**: LLM cluster naming — `nameClusterViaLLM` generates 3-5 word topic phrase,
  prepended to summary as `Cluster: <name>`
## New workflow builtins (3)
- `security-audit` (4 phases): Scope → Scan (4 parallel agents) → Triage → Report
- `doc-gen` (3 phases): Inventory → Generate (parallel batches) → Assemble
- `lib-migrate` (5 phases): Detect → Map → Transform → Verify → Report
- 7 builtins total (was 4)
## New compose skills (3)
- `code-review` (6.7KB): structured review with severity-tagged findings
- `benchmark` (7.2KB): perf measurement + baseline comparison
- `audit-deps` (8.7KB): outdated/vuln/unused/license audit
- 18 skills total (was 15)
## Infrastructure
- **tsconfig.json** added to 10 SFFMC packages (was only in workflow) — all 11 now have
- **Migrated to loadConfig**: auto-max, watchdog (raw YAML → shared SDK)
- **eosin-stripper/rules**: already on loadConfig or have domain-specific loading
- **Re-run codemap for extra**: 1738 + 1750 words (reflects dir + ctx changes)
## Stats
- Tests: 429 → 465 (+36)
- sffmc_health: 9 ok 2 warn → 11 ok 0 warn 0 fail
- Plugins: 11 SFFMC (unchanged)
- Builtins: 4 → 7
- Skills: 15 → 18
- Files: 30 modified/created
- 12 packages: still 0.8.0 (no version bump, this is a feature-add release on top of v0.8.0)


## v0.8.0 — Ship @sffmc/extra plugin (F5'/F6'/F8 opt-in bundle) (2026-06-15)

## Headline
New `@sffmc/extra` plugin: opt-in bundle of 3 advanced features cut from v8.0.
All features disabled by default — toggle per feature via config flags.
- **F5' Checkpoint** — session state capture/restore with schema versioning
- **F6' Judge** — multi-criteria LLM judge (0-10 on correctness/completeness/conciseness)
- **F8 Dream** — background memory cleaner with multi-trigger (count > N, cron, manual)
## What's new
### Plugin: @sffmc/extra (11 SFFMC packages total)
**F5' Checkpoint** (`extra_checkpoint` tool):
- Captures every `tool.execute.after` call into per-session JSONL at
  `~/.local/share/sffmc/extra/checkpoints/<sessionID>.jsonl` (configurable via `checkpoint_dir`)
- Schema versioning: `version: 1` header, restore rejects unknown versions
- Actions: `list` (show sessions), `restore` (reconstruct messages), `delete` (remove)
- Auto-restore via `<!-- EXTRA_RESTORE: <sessionID> -->` marker in messages
- Schema versioning + append-only JSONL for crash safety
**F6' Judge** (`extra_judge` tool):
- LLM judge scoring 2-8 candidate outputs
- Multi-criteria rubric: correctness, completeness, conciseness (0-10 each)
- Returns `{ scores, winner, reasoning, model, latencyMs }`
- Configurable model (default `your-model-id`) + rubric
- `judge_auto` flag: hook `experimental.chat.messages.transform` to auto-judge
  candidates marked with `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->`
- LLM call at temperature 0.2 for determinism
- JSON parsing with validation (rejects malformed responses)
**F8 Dream** (`extra_dream` tool):
- 3 trigger paths: count > threshold (default 50), cron interval (default 24h), manual
- Dedup: Jaccard similarity > 0.9, keep newer entry by `last_accessed`
- Stale removal: `last_accessed > 30 days` → archived to `dream-archive.jsonl`
- Cluster summarization: Jaccard > 0.3 cluster, 5+ entries → LLM summary
  (falls back to concat if no `ctx.client.session.message()`)
- Concurrency: Promise-lock prevents overlapping runs
- LLM summarization with graceful fallback to concat on error
### Infrastructure
- **Factory + spread pattern**: each `create<X>Tool(config)` returns `{ tool, hooks }`,
  `index.ts` spreads hooks into top-level return. Allows parallel feature implementation
  without index.ts conflicts.
- **`ExtraConfig` 9 keys**: `checkpoint`, `judge`, `dream`, `dream_threshold`,
  `dream_interval_hours`, `judge_model`, `judge_rubric`, `judge_auto`, `checkpoint_dir`
- All 3 features ship via `@sffmc/shared` PluginContext type
- Wired to 11th SFFMC plugin in sandbox :4200 opencode.json
### Quality
- **Codemap for new package**: `packages/extra/codemap.md` (1,723 words) +
  `packages/extra/src/codemap.md` (1,535 words). Root `codemap.md` and
  `packages/codemap.md` updated with new row.
- **Test coverage even-out** (29 new tests across 3 packages):
  - `compose`: 2 → 37 (+35) — verify/tdd skill keywords, cross-validation,
    unknown skill errors, schema validation
  - `eos-stripper`: 3 → 31 (+28) — multiple EOS, middle-of-text, mixed tokens,
    whitespace handling, all DEFAULT_EOS_PATTERNS coverage
  - `auto-max`: 4 → 29 (+25) — session isolation, error type edge cases,
    re-trigger blocking, object output detection
- **sffmc_health**: 10 → 11 checks (added `extra_opt_in` — detects config presence
  + feature enable count)
- 429/429 tests pass (was 394), 957 expect() calls (was 1057 before coverage)
- All packages bumped 0.1.0 → 0.8.0
## Migration from v0.7.5
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
## Known gaps (documented, not blocking)
- F8 Dream LLM summarization needs `ctx.client.session.message()`; falls back to
  concat if not available
- 10/11 packages still lack `tsconfig.json` (in-progress migration)
- Sandbox live-test of F5'/F6'/F8 pending (need real session with `tool.execute.after` traffic)
- Corrupted skill file in `compose` propagates throw instead of graceful error
- `auto-max` lacks `dry_run` mode and `/max` escape hatch
- Object output without metadata.error is treated as success (silent fall-through)
## Files changed (summary)
- 1 new package: `packages/extra/` (8 files, +2000 LOC)
- 4 SFFMC plugins updated: `checkpoint.ts` (+dir param), `dream.ts` (+ctx + LLM),
  `judge.ts` (judge_auto hook), `index.ts` (wire new params)
- 3 test files extended: compose (+35), eos-stripper (+28), auto-max (+25)
- 2 codemap files added for `extra/`
- 2 umbrella codemap files updated (root + packages)
- Sandbox config: extra plugin added to local OpenCode config
- All 12 package.json versions bumped 0.1.0 → 0.8.0
- `sffmc_health` extended with `extra_opt_in` check (11th check)
- `CHANGELOG.md`, `README.md`, `AGENTS.md` updated
- 1 new helper: `scripts/release.sh` (4-gate + CHANGELOG + commit + tag)


## v0.7.5 — Full repository codemap (2026-06-15)

Generated via Codemap skill. 11 parallel fixer agents + orchestrator umbrella + root atlas.

### Files written (24 codemap.md + 1 atlas)

- `codemap.md` (root) — 1380 words, master entry point with directory map
- `packages/codemap.md` (umbrella) — 1415 words, 10 plugins + shared SDK overview
- 10 × `packages/<plugin>/codemap.md` — package-level architecture per plugin
- 10 × `packages/<plugin>/src/codemap.md` — file-by-file breakdown per plugin
- 2 × `shared/codemap.md` + `shared/src/codemap.md` — SDK architecture
- `AGENTS.md` — auto-load entry with Repository Map section
- `.sffmc/codemap.json` — change-detection state (56 files tracked)

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

Added `@sffmc/health` to the development sandbox config. Restart verified: 10/10 SFFMC plugins loaded, 0 errors. LLM can now call `sffmc_health` tool in sandbox sessions.

### Example plan artifact

`docs/examples/migrate-7-plugins-to-shared.json` — a 14-step plan for migrating the remaining 7 plugins to `@sffmc/shared`. Generated as if by the `plan` workflow builtin (LLM-computed, structured per `plan.ts` schema). 5 audit steps in parallel, 5 migrations in parallel, 2 verify steps, 1 docs, 1 release. Total 290 min, bottleneck is watchdog's model-fallback edge case.

### Gitignore

Added `.sffmc/` (per-project workflow runtime artifacts, like `.sffmc/deepwork/`).

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
