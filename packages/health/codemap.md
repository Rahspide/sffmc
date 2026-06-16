# packages/health/

## Responsibility

Runs 7 diagnostic checks against the SFFMC monorepo and returns a JSON health report. Exposed as both an LLM-callable tool (`sffmc_health`) and a standalone importable function (`runAllChecks`). Primary consumer: plugin authors before releases or after changes.

## Design Patterns

- **Function composition** — 7 independent `CheckFn` functions, each receiving `repoRoot: string` and returning `Promise<CheckResult>`. The orchestrator `runAllChecks` accepts a custom `CheckFn[]` parameter (defaults to `ALL_CHECKS`), making individual checks swappable for testing and selective runs.
- **Wrapper pattern** — `server` function defined as a local async arrow that calls the module's default export shape `{ id, server }`. Used for OpenCode's `tool` hook, not imported directly (avoids silent-fail bug with `server: importedFn` in loader).
- **JSON response shape** — `HealthResult { ok: boolean, checks: CheckResult[], summary: string }`. `ok` is `false` only when any check has `status: "fail"` (warns do not flip it). `summary` is a human-readable count string. Tool `execute` returns `JSON.stringify(result, null, 2)` — LLM-readable but not parsed inline.
- **Lazy orchestration** — all 7 checks run in parallel via `Promise.all`. No inter-check dependencies. Each check handles its own existence/error guards internally (returns `CheckResult`, never throws).
- **Defensive I/O** — every fs op wrapped in try/catch returning structured results. Missing files → `status: "fail"` with "not found" detail, not a thrown error.

## Data & Control Flow

```
LLM calls sffmc_health()
  → tool.execute()
    → runAllChecks(repoRoot)
      → Promise.all(ALL_CHECKS.map(fn => fn(repoRoot)))
        ├── checkHookConflicts: spawns python3 audit script → reads JSON report → classifies hook overlaps
        ├── checkTestPresence: reads packages/* + shared/ → grep *.test.ts in src/ and tests/
        ├── checkReadmePresence: reads packages/* + shared/ → stat README.md
        ├── checkTypeCheck: bun build --no-bundle per package → parse stderr for errors
        ├── checkToolRegistration: reads compose/index.ts + workflow/tool.ts → indent-aware parser for `name:` field bug
        ├── checkVersionConsistency: reads root package.json → compares all pkg versions
        └── checkLicense: stat LICENSE → grep READMEs for /(LICENSE|MIT|license)/
      → aggregate: count ok/warn/fail, set ok=false if failCount>0
      → return HealthResult
  → JSON.stringify(result, null, 2)
```

## OpenCode Hooks

- **`tool`** — registers `sffmc_health` with description, empty parameters JSON Schema (`{ type: "object", properties: {} }`), and async execute function. No other hooks.

## Integration Points

| Dependency | Used By |
|---|---|
| `@sffmc/shared` (types only) | `server(ctx: PluginContext)` — extracts `projectRoot` from context |
| `node:fs/promises` | `readdir`, `readFile`, `stat` — all check functions |
| `node:path` | `join` — path construction for `repoRoot`-relative lookups |
| `Bun.spawn` | `checkHookConflicts` (python3 audit script), `checkTypeCheck` (bun build per package) |
| `scripts/audit-load-order.py` (external) | `checkHookConflicts` — spawns as subprocess, reads `.sffmc/load-order-audit.json` output |
| `bun build --no-bundle` (external) | `checkTypeCheck` — spawns per-package typecheck, parses stderr exit codes |

## Public API

| Export | Kind | Signature |
|---|---|---|
| `runAllChecks` | async function | `(repoRoot: string, checkFns?: CheckFn[]) => Promise<HealthResult>` |
| `checkHookConflicts` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkTestPresence` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkReadmePresence` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkTypeCheck` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkToolRegistration` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkVersionConsistency` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `checkLicense` | async function | `(repoRoot: string) => Promise<CheckResult>` |
| `CheckResult` | type | `{ name: string; status: "ok" \| "warn" \| "fail"; detail: string }` |
| `CheckFn` | type | `(repoRoot: string) => Promise<CheckResult>` |
| `HealthResult` | type | `{ ok: boolean; checks: CheckResult[]; summary: string }` |
| `default` | plugin module | `{ id: "@sffmc/health", server: (ctx: PluginContext) => Promise<{ tool: { sffmc_health: {...} } }> }` |

## Notable

- **Only plugin (besides invoke script) that exposes its main function as both a tool AND a standalone importable function.** `runAllChecks` is importable without OpenCode; the `tool` hook wraps it for LLM access.
- **Tool definition has NO `name` field** — follows DLC pattern where the key in the `tool` object IS the name. `checkToolRegistration` is a regression guard verifying this across the repo (fix-17).
- **`packageNames()` handles `shared/` specially** — it lives at `<repoRoot>/shared/`, not under `packages/`, but gets included if `shared/package.json` exists. This mirrors the monorepo's workspace structure where `@sffmc/shared` is at the root level.
- **`checkHookConflicts` uses a safelist** — 14 hooks (`config`, `event`, `tool.execute.before/after`, `command.execute.before/after`, DCP text transforms, `permission.*`, `tool`, `chat.*`) are classified as safe-for-multi-registration. Only hooks outside this set appearing in multiple plugins are flagged as real conflicts.
- **Version check uses `warn` not `fail` status** — version mismatches are advisory, not blocking. Only root `package.json` unreadable yields a `fail`.