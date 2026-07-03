## v0.15.3 (2026-07-03)

> Maintenance release. **No breaking changes.** 25+ fixes covering config gaps, security, health checks, docs drift, and stale references. Recommend upgrade for everyone, especially on multi-user systems (mkdir mode fix) and v0.14.5/v0.14.7/v0.14.8 holdouts.

### Fixed

#### Configuration gaps (v0.14.5's "21 values configurable" overstated)

- **Sandbox pump cadence now reads `WorkflowExtendedConfig`** — `packages/runtime/src/sandbox.ts:336-338` was using inline `const SLOW_MS = 50; const FAST_WINDOW = 50` instead of the existing `getSandboxSlowMs()` / `getSandboxFastWindow()` getters. Now user YAML overrides (`sandboxSlowMs`, `sandboxFastWindow`, `sandboxFastMs`) take effect.
- **`FlushManager` debounce now reads `getFlushDebounceMs()`** — `packages/runtime/src/flush-manager.ts:44` had `private static readonly DEBOUNCE_MS = 250` shadowing the config getter. Constructor takes optional `debounceMs` parameter; `runtime.ts` passes `getFlushDebounceMs()`.
- **`WorkflowPersistence` fsync coalesce now reads `getFsyncCoalesceMs()`** — `persistence.ts:172` had `const FSYNC_COALESCE_MS = 50` shadowing the config getter. `scheduleFsync()` at line 261 now calls `getFsyncCoalesceMs()`.
- **`SAFE_REPETITION_LIMIT` exported from utilities** — `packages/safety/src/rules/rules.ts:16` had `const SAFE_REGEX_LIMIT = 25` duplicating `packages/utilities/src/config.ts:17`. Now exported as `SAFE_REPETITION_LIMIT` from `@sffmc/utilities` and imported by `safety/rules`. Single source of truth for the ReDoS cutoff.

#### Security

- **All 5 runtime persistence `mkdir` calls now use `mode: 0o700`** — `persistence.ts:220,369,412,427,484` previously called `mkdir(this.dir, { recursive: true })` without `mode`, leaving the runtime data dir readable by other users on multi-user systems. Brings runtime in line with memory/dream/checkpoint which already use `mode: 0o700` since v0.12.1.
- **`migrateLegacyDataPaths()` removed** — exported but never wired into any bootstrap path, so it could never fire. The function pretended to migrate `~/.config/SFFMC` → `~/.config/sffmc` on first run; in practice nothing called it. Canonical path stays uppercase `SFFMC/` for backward compatibility. If a future migration to lowercase is desired, it must be wired into `activation.ts` and ship as a planned breaking change.
- **5 new redaction patterns** — `packages/utilities/src/redact-secrets.ts:118` `cloud-credential` rule expanded to cover: GitHub fine-grained PAT (`github_pat_*`), GitHub OAuth/user/scope tokens (`gho_*`/`ghu_*`/`ghs_*`/`ghr_*`), GitLab PAT (`glpat-*`), Discord bot tokens (`d_*` prefix), Stripe live keys (`sk_live_*`, `rk_live_*`), and JWTs (three base64url segments separated by dots).
- **`redactSecrets()` `MAX_CONTENT_BYTES` guard** — exports new `MAX_CONTENT_BYTES = 1_048_576` (1 MiB). Inputs larger than this return unchanged with `{ oversize: true, categories: ["oversize"] }` so callers can chunk-stream or warn.

#### Health plugin

- **`checkCompositeStructure` no longer hardcodes "3 composites"** — message now uses `expectedComposites.length` and joins the actual list (`safety + memory`). Was stale since v0.15.0 dissolved `@sffmc/agentic`.
- **`checkExtraOptIn` refactored** — was looking for the deleted `packages/extra/` directory and reading `~/.config/SFFMC/extra.yaml`. Both paths are gone since v0.15.0 (extra moved to `@sffmc/memory`, utilities became a permanent library). Function still exists for log-scraper compatibility but returns `ok` with a "permanent library, no opt-in required" detail.
- **`checkChangelogCurrency` now also verifies `CHANGELOG.ru.md`** — the bilingual docs promise is a soft contract (warn, not fail). Reports missing RU file or out-of-sync top version.

#### Audit script

- **`scripts/audit-load-order.py` error message fixed** — claimed `expected 14` packages but actually checks `== 5`. Updated to `expected 5`.
- **`scripts/check-cleanroom.sh` cleaned up** — removed dead EXCLUDE_PATTERNS for deleted `packages/compose/`, `packages/agentic/` (dissolved in v0.15.0 P-1). Removed `shared/` from grep scopes (directory no longer exists post-consolidation).

#### Documentation drift

- **`docs/dynamic-workflow.md`** — "12 hours wall-clock" → "1 hour wall-clock" (×3 refs; was Manriel v0.12.1 reduction that never propagated to docs). "Direct MCP bindings planned" → "available since v0.14.0" (was false, mcp.list()/mcp.call() shipped in v0.14.0).
- **`bin/sffmc` (bash) help text updated** — "13 packages / 13-check diagnostic" → "5 packages / 9-check diagnostic" (v0.15.1 fixed PowerShell only). `--minimal` flag description: "3 composite packages" → "4 packages (2 composites + 2 most-used standalones)".
- **`CONTRIBUTING.md`** — "v0.15.1 is the current release" → "v0.15.3 is the current release".
- **`docs/install.md`** — `SFFMC_VERSION=v0.15.0` (×2) → `SFFMC_VERSION=v0.15.3`.
- **`CHANGELOG.md`** — "v0.14.7" stale references (×2) → "v0.14.9" (v0.14.7 never released; auto-migration shipped in v0.14.9).

#### Phantom file refs (cleanup)

- **`packages/utilities/src/redact-secrets.ts` MIN_TOKEN_LENGTH extracted** — 4 patterns (`api-key-assignment`, `token-assignment`, `bearer-header`) all hardcoded `{16,}` duplicated. Now built via `RegExp` constructor with `${MIN_TOKEN_LENGTH}` interpolation at module load. Reduces drift risk if threshold changes.
- **11 source files** — references to `.slim/deepwork/hardcode-audit-2026-06.md` and `.slim/deepwork/phase-2-3-hardcode-migration-plan.md` (phantom files, not in git) replaced with brief historical note pointing to CHANGELOG.md v0.14.5. Affects: `packages/memory/src/extra/{dream,index,judge}.ts`, `packages/cognition/src/{compose,max-mode}/*`, `packages/safety/src/watchdog/index.ts`.
- **`packages/utilities/src/fs-ops.ts`** — reference to phantom `docs/superpowers/plans/2026-06-30-v0.15.0-implementation.md` replaced.

# SFFMC Changelog

## v0.15.2 (2026-07-02)

> Maintenance release. **No breaking changes.** Recommend upgrade for anyone installing from npm.

### Fixed

- **Empty npm package pages** — `packages/utilities`, `packages/cognition`, `packages/runtime` shipped in v0.15.0/v0.15.1 without `description`, `keywords`, `bugs`, or `homepage` fields in their `package.json`. The npm registry page rendered as "no description" even though the tarball itself was complete. Added human-readable descriptions + keyword arrays + bugs/homepage links (matching what `@sffmc/safety` and `@sffmc/memory` already had).

### Added

- **Russian CHANGELOG entries** for v0.15.0 and v0.15.1 in `CHANGELOG.ru.md` — bilingual documentation gap closed.

## v0.15.1 (2026-07-02)

> Maintenance release. **No breaking changes.** Recommend upgrade for users on Windows + for anyone who hit the docs drift catalogued in v0.15.0.

### Fixed

- **`bin/sffmc.ps1` functional regression** — PowerShell installer has been shipping broken `init` since v0.15.0: `PLUGIN_DIRS` still listed 13 paths to deleted packages (`agentic`, `watchdog`, `rules`, `auto-max`, `eos-stripper`, `log-whitelist`, `extra`, `max-mode`, `workflow`, `compose`, `health`). `sffmc init` was silently skipping them with `Unknown package: agentic (skipping)` warnings instead of adding the 4 valid plugins. Now matches the bash version. Windows users running `irm .../install.ps1 | iex` get a complete install.

- **Stale refs across all v0.15.0 docs** — `docs/install.md`, `docs/getting-started.md`, `docs/drone-ci.md`, `docs/import-from-mimo.md`, `docs/migration-from-opencode.md`, `CONTRIBUTING.md`, `AGENTS.md`, `install.sh`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, `packages/{memory,safety}/*` updated to reflect the actual 5-package layout (2 composites + 3 standalones, `@sffmc/utilities` as library). The line-7 paragraph of `getting-started.md` that read "@sffmc/safety, @sffmc/safety, @sffmc/safety, @sffmc/safety" (literal copy-paste from the EN source pre-bug) has been rewritten cleanly.

- **Broken documentation links** — `packages/memory/README.md` linked to the deleted `../extra/README.md`; `packages/safety/README.md` linked to 5 sibling sub-feature paths that no longer existed as top-level packages. All repointed.

- **`install.sh` help text** — `sffmc init --all install all 13 packages` and `sffmc doctor run 13-check diagnostic` updated to `5 packages` and `9-check diagnostic`.

- **`packages/safety/skills/write-rule.md`** — `bun test packages/rules/` → `bun test packages/safety/src/rules/` (rules is now a sub-folder).

### Added

- **Real README content** for `packages/runtime/README.md`, `packages/cognition/README.md`, `packages/utilities/README.md`. They were 3-line placeholders auto-generated by the v0.15.0 P-1 migration; this release fills them in.

## v0.15.0 (2026-06-30)

### Changed (consolidated 13 → 5 packages)

- **Package consolidation** — 14 workspace members (13 packages + `shared/`) consolidated into 5 packages:
  - `@sffmc/runtime` (was `@sffmc/workflow`)
  - `@sffmc/cognition` (was `@sffmc/max-mode` + `@sffmc/compose` + `@sffmc/health`; replaces dissolved `@sffmc/agentic`)
  - `@sffmc/guard` — package metadata layer (the 5 governance standalones are now internal sub-folders of `@sffmc/safety`)
  - `@sffmc/persist` — package metadata layer (now an internal sub-folder of `@sffmc/memory`)
  - `@sffmc/utilities` (was `shared/`)
  - `@sffmc/safety` and `@sffmc/memory` retained as composites; their `composes[]` is now empty (members are internal sub-folders)
- **`@sffmc/agentic` composite dissolved** — users must now register `@sffmc/runtime` and `@sffmc/cognition` explicitly in `opencode.json` `plugins[]`
- **Imports updated across the codebase** — `@sffmc/{workflow,max-mode,compose,health,rules,watchdog,auto-max,eos-stripper,log-whitelist,extra,agentic,shared}` → `@sffmc/{runtime,cognition,safety,memory,utilities}` as appropriate

### Added (test/exports)

- `@sffmc/shared` → `@sffmc/utilities`: `FsOps` interface + `defaultFsOps` + `createMockFsOps()`
- `@sffmc/shared` → `@sffmc/utilities`: `unixNow()` + `__setClock()` + `__resetClock()`
- `@sffmc/shared` → `@sffmc/utilities`: `isSafeRunID()` + `safeRunID()` + `RUN_ID_REGEX`

### Fixed (Medium + Low audit findings — Phase 1 + Phase 2 work)

- **God-object extract**: `WorkflowRuntime` split into `CounterManager`, `WorkflowEventEmitter`, `OutcomeStore`, `WorkflowActivation`, `FlushManager` (per-entry / per-runtime / single-concern)
- **God-object extract**: `packages/extra/src/checkpoint.ts` (1296 LOC) split into 13 focused modules under `packages/extra/src/checkpoint/`
- **Long function split**: `runDream` (259→117 LOC), `runSandboxed` (175→99 LOC), `createJudgeTool` (158→123 LOC), `createDreamTool` (157→57 LOC), plus 19 other orchestrators reduced via private-helper extraction
- **Testability primitives** wired into 4 packages: `mockFsOps` mocking, `__setClock` time-travel, `safeRunID` export, `WorkflowPersistence` FsOps injection
- **Naming**: 4 high-impact renames (`o` → `agentOpts` × 2; `sanitizeResult` → `sanitizeValue`; `n` → `candidateCount`; `result` → `scratch`)
- **Hot-path tweaks**: `MAX_OVERFLOW` defense-in-depth clamp in `loadAndCacheMemories`; multi-factory cron timer cleanup in `createDreamTool`
- **Module-level state** promoted to instance fields: `fsyncPendingPaths` + `fsyncTimer` → `WorkflowPersistence` instance; `lockMap` → new `Concurrency` class
- **Ops**: regenerated `bun.lock` (workspace versions 0.14.3 → 0.15.0); removed dangling `better-sqlite3` symlink

### Migration

| Old npm | New npm | Migration |
|---|---|---|
| `@sffmc/workflow` | `@sffmc/runtime` | rename |
| `@sffmc/max-mode` | `@sffmc/cognition` | rename |
| `@sffmc/compose` | `@sffmc/cognition` | rename (composite subsumes) |
| `@sffmc/health` | `@sffmc/cognition` | rename (composite subsumes) |
| `@sffmc/rules` | `@sffmc/safety` | rename (composite subsumes) |
| `@sffmc/watchdog` | `@sffmc/safety` | rename (composite subsumes) |
| `@sffmc/auto-max` | `@sffmc/safety` | rename (composite subsumes) |
| `@sffmc/eos-stripper` | `@sffmc/safety` | rename (composite subsumes) |
| `@sffmc/log-whitelist` | `@sffmc/safety` | rename (composite subsumes) |
| `@sffmc/extra` | `@sffmc/memory` | rename (composite subsumes) |
| `@sffmc/agentic` | (removed) | replace with **two** entries: `"@sffmc/runtime": {}` and `"@sffmc/cognition": {}` in `opencode.json` `plugins[]` |
| `@sffmc/safety` | `@sffmc/safety` | unchanged |
| `@sffmc/memory` | `@sffmc/memory` | unchanged |
| `@sffmc/shared` | `@sffmc/utilities` | rename (library; not a plugin) |

> **Note on `@sffmc/utilities`:** not a plugin entry point. Consumers using the SDK as a library must update their imports; do not add `"@sffmc/utilities": {}` to `opencode.json` `plugins[]`.

---

## v0.14.9 (2026-06-28)

### Changed

- **Dropped v1 checkpoint readers** — `packages/extra/src/checkpoint.ts` no longer exposes `migrateV1ToV2` or the `CheckpointHeaderV1` type. The header parser auto-migrates any v1 file to v2 on read; the migrated file is atomically rewritten as v2 so subsequent reads hit the fast path.

---

## v0.14.8 (2026-06-28)

### Changed

- **Documentation split into English + Russian** — `README.md` is now English-only; a language picker banner at the top links to `README.ru.md`. `CHANGELOG.md` is now English-only; Russian translations live in `CHANGELOG.ru.md`. Both new files contain the same content as the original bilingual inline format, just split for cleaner per-language navigation.

## v0.14.6 (2026-06-21)

### Changed

- **Checkpoint file format v2** — adds indexed random access and CRC32 integrity to the on-disk JSONL layout. v2 files include per-line byte offsets in the header and a CRC32 of the body bytes; each body line also carries a per-line CRC. v1 files remain readable; existing v1 data is migrated to v2 via `migrateV1ToV2(sessionID, dir?)` (explicit call in v0.14.6; auto on first v2 write shipped in v0.14.9).

### Added

- **`migrateV1ToV2(sessionID, dir?)`** — explicit migration from v1 to v2 checkpoint format. Reads v1, writes v2, backs up v1 as `<sessionID>.jsonl.v1.bak`. Returns `MigrationResult { ok, sourceVersion, targetVersion, lines, error? }`.
- **`crc32(data)`** — exported CRC32 (IEEE 802.3 polynomial) helper for callers that need to recompute integrity values.
- **`packages/extra/tests/checkpoint-v2.test.ts`** — covers v1 backward compat, v2 write/read, offset accuracy, CRC32 correctness, migration, and a 100-call stress case.

### Migration

v1 to v2 is one-way. Once a file is v2, the reader does not rewrite it as v1. v1 readers continue to work on v1 files. Auto-migration on first v2 write is planned for v0.14.9, which will drop v1 reader support.

## v0.14.5 (2026-06-21)

### Changed

- **Checkpoint write batching** — `_flushSession` writes all buffered `ToolCall`s in a single `appendFileSync` call instead of N separate calls. On-disk file format is byte-identical to prior releases (one JSON-encoded `ToolCall` per line, terminated with `\n`); existing readers (`readToolCalls`, `readHeader`) are unaffected.

### Added

- **`packages/extra/bench/checkpoint-flush.bench.ts`** — synthetic microbenchmark for `_flushSession` throughput. Drives the `tool.execute.after` hook for 10/100/1000 calls and reports ops/sec plus file size. Run with `bun run packages/extra/bench/checkpoint-flush.bench.ts`.

### Performance

Benchmarks (bun 1.3.14, default `flushThreshold = 50`):

| Buffer size | Throughput | File size |
|---|---|---|
| 10 calls | ~10k ops/sec | 1062 B |
| 100 calls | ~130k ops/sec | 9882 B |
| 1000 calls | ~350k ops/sec | 100782 B |

Sub-millisecond measurements are noisy; file sizes are byte-identical across runs, confirming the batched write produces the same content as the prior loop.

## v0.14.3 (2026-06-20)

### Fixed

- **`this.runs` map leak** — `WorkflowRuntime.close()` now clears `this.runs`; per-run delete on settle (complete/fail/cancel). Previously mcpBridge + journalResults + AbortController accumulated per run for the lifetime of the runtime instance. **Policy exception**: this commit modifies `runtime.ts` (off-limits per v0.14.1 hotfix policy) to fix a known memory leak in long-lived runtimes. The fix is well-tested (5 new tests in `v0-14-3-this-runs-cleanup.test.ts`); the alternative (deferring to v0.15) would have shipped a known regression.
- **`__setWorkflowConfig` test escape hatch moved** — relocated to `tests/_test-helpers/config-cache.ts` behind a `NODE_ENV === "test"` gate. No longer importable from production builds.
- **Doc/comment cleanup** — `recoverOrphanedWorkflows` JSDoc line number, `codemap.md` workflow-resume recovery description, test comment at `w10-w14-hardcode-runtime.test.ts:142`.
- **Phase event field-name mismatch** — `schema-journal.ts` was validating `name` field on phase events but `runtime.ts:942-946` writes `title` field (and `types.ts:57` defines it as `title`). Every phase event written by the runtime was silently rejected by the validator and skipped at `loadJournal` time. Aligned validator + JournalEventPhase type to use `title`. Regression test added in `v0-14-3-schema-journal.test.ts:160` (phase event with pass=3 → maxPass=3 → journal.pass=4).

### Added

- **Journal schema validation** — events written by the workflow runtime are now validated against a declared schema in `persistence.ts:357-390`. Malformed events log at debug level and skip, matching the existing torn-line behavior. Further improvements planned for future releases.
- **Per-package configuration** — 21 hardcoded values (debounce intervals, sandbox thresholds, journal settings, checkpoint parameters) are now configurable via `~/.config/sffmc/{package}.yaml`. Defaults preserve v0.14.2 behavior exactly.

### Maintenance

- **Per-package version drift fixed** — all 14 sub-packages bumped to `0.14.3` (was `0.14.1`).
- **Composite `category: "msp"` field** — added to `agentic`, `memory`, `safety` packages.
- **`release.sh` `check_version_consistency` fix** — dynamic comparison to root version instead of hardcoded `"0.12.0"`.

## Thank you to contributors

Thanks to **@Manriel** for the external security audit that identified many of the hardening items addressed across the v0.12.1–v0.14.x line.

## v0.14.2 (2026-06-20)

**@Manriel**: external security audit closeout (all 30 items) + flushNow NOT NULL fix. See [`README.md`](./README.md) for details. 2 commits since v0.14.1.

## v0.14.1 (2026-06-19)

Hotfix: auto-max cap observability + PEM body redaction + ReDoS CI gate + dynamic-workflow documentation link fix. 4 commits since v0.14.0.

### Added

- **ReDoS CI gate** (`scripts/check-redos.ts`, `tests/registry/redos.test.ts`) — pre-commit check using `safe-regex@^2.1.1`. Catches catastrophic backtracking in any rule registered via `BUILTIN_RULES`. Precommit chain now has 6 gates (typecheck, test, audit-load-order, audit:public, audit:redos, health).
- **Filename rule refactor for ReDoS safety** (`shared/src/redact-secrets.ts`) — 7 filename patterns rewritten from `^X(\.[\w-]+)?$` to `^(?:X|X\.[\w-]+)$` to pass safe-regex star-height-1 check. Identical match set verified by equivalence test.

### Changed

- **Auto-max cap observability** (`packages/auto-max/src/index.ts`) — `handleTrigger` now emits explicit `cap reached (N/M): skipping trigger for ... in session ...` log line when `state.maxCallsThisSession >= config.costCapPerSession` blocks. Previously operators counted stale `TRIGGERED:` log lines and incorrectly assumed cap was bypassed.
- **Watchdog load log model field** (`packages/watchdog/src/index.ts`) — terminal fallback is `"(default)"` instead of empty string. Distinguishes "no fallback configured" from "config didn't load".
- **`__listBuiltinRedactionRules` export** (`shared/src/index.ts`) — for tooling introspection of built-in rules.

### Fixed

- **PEM key body redaction** (`shared/src/redact-secrets.ts`) — PEM regex extended to match full block (header + body + footer). Previously only `-----BEGIN ... PRIVATE KEY-----` header was redacted; the base64-encoded key material body now also redacted. 7 new tests (#29-35).
- **Stale dynamic-workflow documentation link** (`README.md`) — fixed broken link from v0.14.0.

### Not Changed (already clean)

- `**/codemap.md` files — remain gitignored (codemap is internal/regenerated, not source of truth). On-disk edits from the cleanup pass remain as local artifacts.

## v0.14.0 (2026-06-19)

Redaction helper + grace period + MCP integration + docs polish redo. 5 commits since v0.12.1.

### Added

- **Shared redaction helper** (`shared/src/redact-secrets.ts`, 240 LOC) — three pure functions (`isSensitiveFilename`, `isSensitiveSourcePath`, `redactSecrets`) + 15 built-in rules across 4 categories (env files, credential filenames, PEM keys, inline assignments). Configurable via `~/.config/sffmc/redact-secrets.yaml`. Fixes the over-broad regex issue from the external security audit by **@Manriel** (`token` matching `tokendeploy.sh`, `private` matching `private-blog.md`).
- **MCP INHERIT Integration** (`packages/workflow/src/mcp.ts`, 298 LOC) — workflow scripts can call MCP tools inherited from parent session. Two surfaces: `agent({task, tools: "INHERIT"})` resolves parent's MCP tool list and forwards to the AI model as a concrete array; guest globals `mcp.list()` and `mcp.call(name, args)` for direct MCP invocation. Per-run `McpBridge` with budget (`DEFAULT_MAX_MCP_CALLS=500`) + recursion guard (`RECURSION_DEPTH_LIMIT=8`).
- **Docs polish redo** (`commit 312039f`) — recovered lost jargon-removal from dangling commit `f9a42be`. Applied selectively to 13 package READMEs + `docs/install.md` + `packages/memory/skills/recall.md`.

### Changed

- **Grace period hook** (`packages/workflow/src/constants.ts`, `runtime.ts`, `types.ts`) — on OpenCode restart, workflows in `running` state with age ≤ `gracePeriodMs` are marked `paused` (resumable); older ones fall through to journal-presence check. Default `gracePeriodMs = 5 minutes`, ceiling `MAX_GRACE_PERIOD_MS = 24 hours`. Configurable via `~/.config/sffmc/workflow.yaml`. Per `WorkflowConfig` field.
- **Regex narrowing for sensitive paths** — `packages/memory/src/watcher.ts` and `recon.ts` now call into shared `redact-secrets.ts` helpers instead of duplicated 7-regex deny lists. Sensitive filenames anchor to `basename()`; sensitive source paths use both basename and path-level rules.
- **MiMo-Code Features Reference** (`docs/mimo-code-features.md`, 2,198 lines, 209 citations) — pure external reference doc for SFFMC maintainers. Zero references to SFFMC. Documents MiMo's actual API as it exists in source.
- **`audit:public` script exclusion** (`scripts/audit-public-content.sh`) — `docs/mimo-code-features.md` added to `EXCLUDE_FILES` since it legitimately references MiMo-Code's own state (e.g. "15 compose skills" is MiMo's count, not SFFMC's).

### Performance

- Redaction helper has `getCachedRulesSync` lazy cache; plugins call `void ensureRedactionRules()` to pre-load.

### Security

- MCP bridge bypasses `tool.execute.before/after` hooks by construction (recursion-safe).
- Grace period logic preserves existing journal-presence branch as tiebreaker (no behavior change for workflows past grace that have journal entries).

### Deferred to v0.15

> **Status note (post-v0.15.2 audit, 2026-07-03):** the original "planned for v0.15" timeline slipped as the project pivoted to the v0.15.0 package consolidation (13 → 5 packages). 2 of 5 items were silently completed in v0.14.1 — see that release's "Added" / "Fixed" sections above. The other 3 reference phantom files (the 990-line design doc and the hardcode audit markdown are not in git history) and need a clean re-spec before any future implementation work.

- **Checkpoint format change** (was deferred from v0.12.1, not re-scheduled) — *not done*
- **Schema refactor** (design file `docs/v0-14-m4-schema-design.md` not in git; needs re-spec from current `schema.ts` 68 LOC + `schema-journal.ts` 207 LOC) — *not done*
- Hardcode audit findings (audit file `.slim/deepwork/hardcode-audit-2026-06.md` not in repo; v0.14.5 already shipped 21-value migration to `~/.config/sffmc/{package}.yaml`, remaining ~151 numeric literals need re-scan) — *partially done*
- **PEM key body redaction** (out of scope for v0.14) — ✅ shipped in [v0.14.1](#v0141-2026-06-19) "Fixed"
- **ReDoS checker promotion to CI gate** — ✅ shipped in [v0.14.1](#v0141-2026-06-19) "Added"

## v0.12.1 (2026-06-19)

Security hardening — 30 fixes from **@Manriel**'s external security audit.

### Fixed

- **Workflow file path traversal prevention** (`packages/workflow/src/runtime.ts`): `resolveWorkflow()` now rejects paths that escape the workspace root. Tests cover `../`, `/etc/passwd`, and mixed `./dir/../../etc` cases.
- **`input.file` path traversal prevention** (`packages/workflow/src/runtime.ts:450-458`): same protection for the `input.file` workflow field.
- **Git token leakage from URL to header** (`packages/workflow/src/resolve.ts`): tokens moved from URL embeds to `http.extraHeader`.
- **GPG signature verification** after clone/pull; strict GPG mode.
- **Sandbox deadline reduced** from 12 hours to 1 hour wall-clock.
- **Parallel candidate responses capped** at 10 to prevent API abuse.
- **`JSON.parse` hardening for corrupted DB data**: wrapped in try/catch.
- **Dream dedup entries capped** to prevent quadratic blowup.
- **Checkpoint session buffer: real LRU eviction** (`packages/extra/src/checkpoint.ts`): true LRU eviction via `delete + re-set` on every hit (was FIFO).
- **Consistent oversize warnings** across checkpoint reads: `readHeader` and `readToolCalls` now log identical `checkpoint: skipping … exceeds limit` messages.
- **Oversized AGENTS.md rejected** before reading into memory.
- **YAML parsing uses safe schema** (`Schema.JSON`) in rules package.
- **Child workflow resolution anchored to parent workspace**.
- **Restrictive file permissions** on data directories.
- **Restored messages from checkpoint capped at 50**.
- **Sensitive filenames skipped** when indexing memory.
- **Sensitive source paths filtered** from recon injection.
- **Event bus logs error message only**, not full error object.
- **`panicMode` design issue documented** + `resetPanicMode()` added.
- **TOCTOU race in `WorkspaceJail`** documented.
- **`WORKFLOW_LIMITS` validated** before SQL DDL interpolation.
- **Legacy migration failures log warnings** instead of silent swallow.

### Security

- Supply chain hardening: Actions pinned to SHAs, `Invoke-Expression` removed, strict GPG mode.

### Docs

- AGENTS.md: containerised testing policy.

### Deferred to v0.14

- Regex narrowing for sensitive paths (over-broad scope).
- Checkpoint format change.
- Schema refactor, shared redaction helper.
- Sandbox deadline 12 hours → 1 hour grace period (regression risk; needs AGENTS.md hook).

---

## v0.12.0 (2026-06-18)

Workflow Resume Passthrough + 6 priority coverage tests + journal/checkpoint performance + per-session state isolation.

### Added

- **Workflow Resume Passthrough** — when OpenCode restarts mid-workflow, in-flight runs are now marked "paused" (recoverable from journal) instead of "crashed". Use `runtime.resume({ runID })` to continue.
- **Health check factory** — 13 health checks consolidated behind a single factory pattern, removing duplicated boilerplate.
- **Journal format v1** — journals now include a version header for forward compatibility. Existing v0 journals still parse correctly.
- **`workflow:resumed` event** — emitted when a paused workflow is resumed via `runtime.resume({ runID })`.
- **6 priority coverage tests** — race conditions in lock acquisition, agent abort at semaphore, depth-limit enforcement, budget-exceeded detection, debounced counter flush, structural error propagation.

### Changed

- **Performance**: journal files now stream-parse on load (was full-read into memory). (workflow package)
- **Performance**: `readToolCalls` reads the checkpoint file once instead of twice. (extra package)
- **Performance**: `appendJournalSync` coalesces `fsync` calls in a 50ms window; explicit `flushJournalSync()` API for durability. (workflow package)

### Fixed

- **Cross-session state leak in `auto-max` and `max-mode`**: per-session state previously stashed on the shared `ctx` object could leak across sessions in long-running processes. Moved to per-instance `Map<sessionID, …>` in plugin state.
- **Inconsistent logger usage**: 10 `console.*` calls in `extra/checkpoint.ts` and `extra/judge.ts` migrated to the shared `createLogger` helper.

### Removed

- 4 dead `MemoryConfig` fields (`reconBudgets.memory`, `.checkpoint`, `.taskTree`, `.agents`) — only `reconBudgets.tail` was actually read.
- Unused `MAX_COMMAND` import and dead `triggeredLog` field in `auto-max`.
- Duplicate `RichPluginContext` re-declarations in `extra/dream.ts` and `extra/judge.ts` (now imported from `@sffmc/shared`).

### Hygiene

- Pinned `@types/bun` and `bun-types` from `"latest"` to `"1.3.14"`. Purged orphaned `node_modules` (stale `better-sqlite3@11.10.0`).

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

v0.8.2 configs work without changes — all 10 module packages still
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
- @sffmc/memory (Memory + Context Recon)
- @sffmc/rules (Safety Rules)
- @sffmc/watchdog (Auto-recovery)
- @sffmc/max-mode (Parallel drafts)
- @sffmc/auto-max (Auto-escalation)
- @sffmc/compose (15 MiMo compose skills)
- @sffmc/workflow (Dynamic Workflow)
### sffmc-original (4 packages — SFFMC team additions)
- @sffmc/eos-stripper (local model EOS token survival)
- @sffmc/log-whitelist (12GB log file prevention)
- @sffmc/health (plugin-author diagnostic)
- @sffmc/extra (opt-in bundle)
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

## v0.8.1 — Known gaps fixed + opt-in bundle enhancements + 6 new skills/builtins (2026-06-15)

### Fixed

- **compose**: graceful error on corrupted/missing skill file
- **auto-max**: 3 improvements
  - `dry_run: boolean` config — counts failures but doesn't actually trigger max-mode
  - `/max` escape hatch hook (regex matches `/max`, `/max reset`, `/max clear`, `/max reset <id>`)
  - Object output error detection — `{ error }` or `{ code }` fields now counted as failures

### Added

**opt-in bundle enhancements:**
- **Checkpoint**: schema migration — `CURRENT_VERSION=1`, `migrateCheckpoint(raw, fromVersion)`, forward-compat restore
- **Judge**: streaming mode — `callJudgeStream` with `onChunk` callback for `scores`/`winner`/`reasoning`/`complete`/`error` chunks
- **Dream**: LLM cluster naming — `nameClusterViaLLM` generates 3-5 word topic phrase

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

## v0.8.0 — @sffmc/extra plugin (opt-in bundle) (2026-06-15)

### Added

New `@sffmc/extra` plugin: opt-in bundle of 3 advanced features.
All features disabled by default — toggle per feature via config flags.

**Checkpoint** (`extra_checkpoint` tool):
- Captures every `tool.execute.after` call into per-session JSONL at
  `~/.local/share/sffmc/extra/checkpoints/<sessionID>.jsonl` (configurable via `checkpoint_dir`)
- Schema versioning: `version: 1` header, restore rejects unknown versions
- Actions: `list` (show sessions), `restore` (reconstruct messages), `delete` (remove)
- Auto-restore via `<!-- EXTRA_RESTORE: <sessionID> -->` marker in messages
- Append-only JSONL for crash safety

**Judge** (`extra_judge` tool):
- LLM judge scoring 2-8 candidate outputs
- Multi-criteria rubric: correctness, completeness, conciseness (0-10 each)
- Returns `{ scores, winner, reasoning, model, latencyMs }`
- Configurable model (default `your-model-id`) + rubric
- `judge_auto` flag: auto-judge candidates marked with `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->`
- LLM call at temperature 0.2 for determinism
- JSON parsing with validation (rejects malformed responses)

**Dream** (`extra_dream` tool):
- 3 trigger paths: count > threshold (default 50), cron interval (default 24h), manual
- Dedup: Jaccard similarity > 0.9, keep newer entry by `last_accessed`
- Stale removal: `last_accessed > 30 days` → archived to `dream-archive.jsonl`
- Cluster summarization: Jaccard > 0.3 cluster, 5+ entries → LLM summary
- Concurrency: Promise-lock prevents overlapping runs
- LLM summarization with graceful fallback to concat on error

### Migration from v0.7.5

No breaking changes. To opt in to the extra bundle, add to `~/.config/SFFMC/extra.yaml`:
```yaml
checkpoint: true      # capture + restore
judge: true           # multi-criteria LLM scoring
dream: true           # background memory cleaner
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

## v0.7.4 — Shared SDK migration + test output cleanup (2026-06-15)

### Changed

- 3 additional plugins migrated to `@sffmc/shared` (`PluginContext` + `loadConfig`): `@sffmc/rules`, `@sffmc/auto-max`, `@sffmc/watchdog`
- `@sffmc/compose` and `@sffmc/memory` also updated
- Test output: reduced noisy `[watchdog] loaded` / `[auto-max] loaded` logs from 8 lines to 2 per test run

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

## v0.7.2 — Health plugin (2026-06-15)

Revived Health as a real diagnostic tool. Plugin authors can now run `sffmc_health` to check monorepo health in <1s.

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

## v0.6.1 — Load order audit (2026-06-15)

Post-release patch:
- `docs/load-order-audit.md` — full audit of 9 SFFMC plugin hooks, 0 conflicts found
- `scripts/audit-load-order.py` — reusable AST-based hook auditor
- All critical sequences verified: /max reset→activate, watchdog→log-whitelist→auto-max output chain, eos-stripper→log-whitelist text chain
- Tool names: only `compose_skill` (compose) and `workflow` (workflow) — no conflicts

No code changes. No plugin version bumps. Pure docs + tooling.

## v0.6.0 — Dynamic Workflow engine (2026-06-14)

9 SFFMC plugins shipped:
- @sffmc/memory — FTS5 + ICM extraction
- @sffmc/rules — YAML gate-based allow/deny
- @sffmc/watchdog — 3-failure counter, auto-recovery
- @sffmc/eos-stripper — EOS token cleanup
- @sffmc/log-whitelist — agent log filter
- @sffmc/max-mode — parallel drafts + judge
- @sffmc/auto-max — auto-escalation to max-mode
- @sffmc/compose — 15 compose skills
- @sffmc/workflow — NEW

Workflow engine:
- Sandboxed JavaScript via quickjs-emscripten WASM
- 3 primitives: agent(), parallel(), pipeline()
- 5-layer budget: lifecycle 1000, concurrent 16, depth 8, wall-clock 12 hours, token 2M
- 3-layer state: SQLite row + per-run script + JSONL journal
- Resume from crash (SHA-256 edit detection)
- Canonical example: deep-research (6 phases, adversarial jury)
- 96+ tests passing

## v0.5.0 — Compose skills (2026-06-14)

- @sffmc/compose: compose_skill tool, 15 skills from MiMo-Code
- Plan, TDD, verify, task delegation, and 11 other structured workflows

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
