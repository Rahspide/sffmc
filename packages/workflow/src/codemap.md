# packages/workflow/src/

## Responsibility

Core implementation of the @sffmc/workflow plugin — the sandboxed JavaScript orchestrator for 200+ step multi-phase workflows. Contains the WorkflowRuntime, quickjs-emscripten sandbox engine, persistence layer, event bus, workspace jail, script resolver, metadata parser, builtin registry, and the workflow tool definition. All 16 source files in this directory plus 4 `builtin/` files form a self-contained plugin with no external runtime dependencies beyond `quickjs-emscripten` and `yaml`.

## Design Patterns

**Plugin Entry (index.ts)** — Default export with `id: "@sffmc/workflow"` and `server(ctx)` function. Creates a `WorkflowRuntime`, registers it in the singleton ref, wires observability listeners (`workflow:agent_failed`, `workflow:finished`), and returns `config` (orphan recovery) + `tool` (workflow registration) hooks. Uses the wrapper pattern (`server: async (ctx) => { ... }`) required by OpenCode 1.17.x plugin loader.

**Tool → Runtime wiring** (`tool.ts` → `index.ts`): `createWorkflowTool(runtime)` passes the runtime directly to the tool's `execute()` function. No global ref needed; tool closes over the runtime.

**Sync-Promise Bridge (sandbox.ts)** — Host functions returning Promises are bridged into the guest via `ctx.newPromise()`. When the host promise settles, `executePendingJobs()` runs synchronously so guest microtasks advance immediately. A concurrent pump (adaptive 1-50ms polling) drains guest-internal pending jobs. Deferred promises (`QuickJSDeferredPromise[]`) are tracked and disposed before context disposal to prevent process abort from live GC objects.

**Deterministic Environment (sandbox.ts)** — Before user code runs, the guest context is stripped of nondeterministic surfaces: `Date` deleted (wall-clock), `Math.random` replaced with seeded mulberry32 PRNG, `WeakRef`/`FinalizationRegistry` deleted (GC liveness callbacks). The PRNG seed is derived from `sha1(runID)` for reproducibility; `DEFAULT_PRNG_SEED = 0x9e3779b9` as fallback for tests.

**Guest-Side PRELUDE (sandbox.ts)** — `parallel()` and `pipeline()` are defined as guest-side JS that maps to `Promise.all`/`.reduce()` — no host round-trips per thunk/stage. A minimal `URL` class is provided for dedup/extraction in workflow scripts (no Web URL in bare QuickJS). This is injected as a string eval before user code.

**Recursive-Descent Meta Parser (meta.ts)** — Parses `export const meta = { ... }` WITHOUT executing the script body or the literal. Uses a hand-rolled reader supporting objects, arrays, strings, numbers, booleans, null, line/block comments, and `\u` escapes. Max depth 100. Returns `{ ok: true, meta, body }` or `{ ok: false, error }`. The `body` output replaces the meta block with whitespace so origin line numbers are preserved (comment-aware brace balancing in `findBalancedClose`).

**Canonical Journal Keys (persistence.ts)** — Agent journal keys are `sha256(canonicalJSON({prompt, agentType, model, schema, phase})):occurrence`. The `canonical()` helper recursively sorts object keys and strips non-deterministic ordering. This ensures the same agent call in a different execution order gets the same base key. Combined with SHA-256 edit detection on resume, this enables deterministic replay.

**Base62 RunID (persistence.ts)** — 19 bytes of `crypto.randomBytes()` → BigInt → base62 encoding → 26-char string with `wf_` prefix (e.g., `wf_3xK9mB7nP2qR8vL4jW5cA1dF`). Non-cryptographic base62 chosen for URL-safe, human-typable IDs. Validated by `RUN_ID_REGEX` before any filesystem access.

**Lexical Jail (workspace.ts)** — All file primitives resolve user paths against `workspaceRoot` (set via `new WorkspaceJail(root)` constructor, passed to `WorkflowRuntime` via `opts.workspace`). The check `abs.startsWith(root + "/") || abs === root` prevents traversal attacks lexically (no symlink resolution). `globFs` results are filtered for `..` and absolute paths.

**Event Bus (events.ts)** — Map-based pub/sub: `on(name, fn)` returns a key string; `off(key)` unsubscribes; `emit(name, payload)` iterates a copied listener array to allow listeners to `off()` themselves. Listeners never throw (caught silently). 6 event types: `workflow:started`, `workflow:agent_failed`, `workflow:phase`, `workflow:log`, `workflow:finished`, `workflow:step_checkpoint`.

**Deferred Outcome Pattern (runtime.ts)** — Each `InternalRunEntry` has `outcomePromise` (resolved by `resolveOutcome`). `start()` returns immediately with `{ runID }`; `wait()` awaits `outcomePromise`. This decouples the tool call (which returns JSON) from the long-running sandbox execution.

**Flush Scheduling (runtime.ts)** — DB counter updates are debounced via 250ms `setTimeout`. `scheduleFlush()` sets a timer if none exists; `flushNow()` updates `workflow_runs.running/succeeded/failed`. This prevents DB thrash during rapid agent spawning while keeping persisted state close to live.

**Semaphore (runtime.ts)** — Promise-based semaphore: `run(fn)` queues callers when `active >= max`. Calls `fn` to get an async resource, decrements active on settle. Used to cap concurrent agent spawns without blocking the event loop.

## Data & Control Flow

```
Tool call: workflow({op: "run", name: "...", args: {...}})
  │
  ├─ tool.ts: execute()
  │   └─ `createWorkflowTool(runtime).execute({ operation: 'run', ... })` → `runtime.start(input)`
  │
  └─ runtime.ts: WorkflowRuntime.start()
      ├─ resolveScript() → builtin-registry or resolve.ts
      ├─ parseMeta() → validate export const meta { name, description }
  ├─ `persistence.createRun(...)` (instance method) → SQLite INSERT + script file write, where `persistence = new WorkflowPersistence({ db?, dataDir? })`
  ├─ WorkspaceJail constructor (per-runtime, lives in `runtime.workspace`)
      ├─ loadJournal() → populate journalResults (empty on fresh run)
      ├─ Create InternalRunEntry with outcomePromise + AbortController
      └─ launchScript() → runSandboxed() [async, fire-and-forget]
           │
           ├─ Build SandboxPrimitives closure (captures entry + counters)
           │   ├─ agent()  → spawnAgent()  → semaphore → cap checks → callLLM → journal
           │   ├─ parallel() → guest PRELUDE Promise.all
           │   ├─ pipeline() → guest PRELUDE .reduce()
           │   ├─ workflow() → spawnChildWorkflow() → recursive start
           │   ├─ phase()  → setPhase() → journal + emit
           │   └─ log()    → appendLog() → journal + emit
           │
           ├─ sandbox.ts: runSandboxed()
           │   ├─ Create QuickJS runtime + context
           │   ├─ injectHooks() → host functions as guest globals
           │   ├─ Determinism hardening (Date, Math.random, WeakRef)
           │   ├─ PRELUDE eval (parallel, pipeline, URL)
           │   ├─ args injection (by-value JSON marshal)
           │   ├─ User script eval wrapped in async IIFE
           │   ├─ Concurrent pump (adaptive 1-50ms polling)
           │   ├─ Deadline Promise.race (12h hard kill)
           │   ├─ ctx.resolvePromise() → ctx.dump() return value
           │   └─ Arena + deferred disposal (prevent process abort)
           │
           └─ result → completeRun(entry, result) or failRun(entry, error)
                └─ resolveOutcome() → workflow:finished event → DB status update
```

## OpenCode Hooks

Registered in `index.ts` → default export → `server()`:

- **`config` hook**: Calls `runtime.recoverOrphanedWorkflows()` — marks any `workflow_runs` rows with status `running` not in the in-memory map as `crashed` with message "Process restarted — workflow orphaned".
- **`tool` hook**: Exports tool via `createWorkflowTool(runtime)` factory — returns `{ tool: { workflow: <tool> } }`. The tool object has no `name` field (key comes from the hook return key, and `name` causes OpenCode 1.17.x to silently reject).

## Integration Points

| Module | Consumed By | Notes |
|--------|-----------|-------|
| `persistence.ts` | `runtime.ts` | All DB/script/journal IO; `WorkflowPersistence` class with `new WorkflowPersistence({ db?, dataDir? })` constructor; `close()` method; instance methods for all 14 CRUD ops |
| `sandbox.ts` | `runtime.ts` | `runSandboxed(source, primitives, opts)` is the sole sandbox entry point |
| `resolve.ts` | `runtime.ts` (via `resolveScript()`) | Resolves workflow names to source strings |
| `workspace.ts` | `runtime.ts` (via primitives) | `new WorkspaceJail(root)` constructed per-runtime in `WorkflowRuntime` ctor; file primitives jailed thereafter |
| `meta.ts` | `runtime.ts`, `resolve.ts` | `parseMeta()` validates and extracts metadata from script source |
| `events.ts` | `runtime.ts` (emit), `index.ts` (on) | Pub/sub for cross-module observability |
| `builtin-registry.ts` | `runtime.ts` (via `resolveScript()`) | Lazy-loads builtin source strings |
| `schema.ts` | `persistence.ts` | DDL applied on first DB connection |
| `types.ts` | All modules | Shared type definitions and default configs |

## Public API

Re-exported through `src/index.ts`:

```ts
// Runtime
export { WorkflowRuntime }         // Core lifecycle: start, status, wait, cancel, resume, list, recoverOrphanedWorkflows

// Persistence
export class WorkflowPersistence — constructor({ db?: Database, dataDir?: string }), close(): void, [14 instance methods]

// Resolution
export { resolveWorkflow, isInlineScript }  // Resolve by name/inline/path
export { parseMeta }                         // Parse export const meta from source

// Registry
export { registerBuiltin, getBuiltin, loadBuiltin, listBuiltins }  // Builtin workflow management

// Events
export function createEventBus() → { on, off, emit, clearAll }  // Event bus factory for observability

// Tool
export function createWorkflowTool(runtime: WorkflowRuntime)

// Config defaults
export { DEFAULT_WORKFLOW_CONFIG, DEFAULT_SANDBOX_CONSTRAINTS }

// Types (all re-exported from types.ts)
export type { WorkflowStatus, WorkflowRun, WorkflowStep, JournalEvent, RunEntry,
              WorkflowConfig, SandboxConstraints, AgentOptions, AgentResult,
              AgentFailureReason, WorkflowStartInput, WorkflowStatusOutput,
              WorkflowOutcome, WorkflowError }
```

## Files

| Path | Purpose |
|------|---------|
| `src/index.ts` (70 L) | Plugin entry point: default export with `id` + `server()`, creates WorkflowRuntime, sets singleton ref, wires observability listeners, registers `config` (orphan recovery) and `tool` (workflow) hooks, re-exports all public API |
| `src/runtime.ts` (985 L) | **Largest file** — WorkflowRuntime class: `start()` creates InternalRunEntry + launches sandbox; `status()`/`wait()`/`cancel()`/`resume()`/`list()` public API; `spawnAgent()` with lifecycle/token/step/abort/depth checks, journal dedup, semaphore gating, LLM call; `runParallel()`/`runPipeline()` (host-side stubs, guest PRELUDE handles actual); `spawnChildWorkflow()` recursive launch; `setPhase()`/`appendLog()` journal + emit; `callLLM()` via OpenCode `ctx.client.session.message()`; `recoverOrphanedWorkflows()` marks stale runs crashed; flush scheduling (250ms debounce); Promise-based semaphore and named lock |
| `src/sandbox.ts` (342 L) | quickjs-emscripten sandbox engine: `runSandboxed()` creates QuickJS runtime+context, injects host functions via `injectHooks()`, applies determinism hardening (delete Date, mulberry32 PRNG, delete WeakRef/FinalizationRegistry), eval's PRELUDE (parallel/pipeline/URL), injects `args`, eval's user script wrapped in async IIFE, runs adaptive concurrent pump (1-50ms), imposes 12h deadline via Promise.race, returns `ctx.dump()` value or `null` on any error (never-throw contract). Arena + deferred disposal in `finally` prevents QuickJS process abort from live GC objects. `marshalIn()` copies host values into guest by JSON. Guest-side PRELUDE (~30 LOC string) defines `parallel`, `pipeline`, and a minimal `URL` class |
| `src/tool.ts` (146 L) | `createWorkflowTool(runtime)` factory: returns a tool object whose `execute()` calls `runtime.start(input)` (or other ops). Runtime passed in as arg, no global ref.
| `src/persistence.ts` (360 L) | `WorkflowPersistence` class. `dataDir` defaults to `process.env.XDG_DATA_HOME ?? ~/.local/share/SFFMC/workflow`. Tests use `new Database(':memory:')` via `db` opt. `generateRunID()` (base62, 19 random bytes, `wf_` prefix); `createRun()`/`loadRun()`/`updateRunStatus()`/`listRuns()` for `workflow_runs` table; `writeScript()`/`readScript()` for per-run `.js` files; `appendJournalSync()`/`appendJournal()`/`loadJournal()`/`clearJournal()` for JSONL journal; `checkpointStep()` for `workflow_steps` (BEGIN EXCLUSIVE/COMMIT); `computeScriptSha()` (SHA-256 of source); `journalKeyBase()`/`journalKey()` (canonical JSON → SHA-256 + occurrence); `close()` method; `safeRunID()` validates `RUN_ID_REGEX` |
| `src/resolve.ts` (91 L) | `resolveWorkflow(nameOrPath, workspace)`: detects inline scripts via `META_RE` regex; resolves absolute/relative file paths; walks up directory tree looking for `.sffmc/workflows/{name}.ts` and `.claude/workflows/{name}.ts`; validates safe name (alphanumeric + `._-`); returns `ResolvedWorkflow { source, meta, kind }`. `isInlineScript()` checks for `export const meta =` pattern |
| `src/workspace.ts` (90 L) | Lexical jail: `WorkspaceJail` constructor takes `root: string`; `resolveInWorkspace(userPath)` checks `abs.startsWith(root+"/") || abs===root` and throws on escape; `readFile_()` returns null on ENOENT (never-throw for missing files); `writeFile_()` creates parent dirs; `exists()` checks via `access()`; `glob()` uses `fs.glob` with cwd, filters out `..` escapes and absolute paths |
| `src/events.ts` (107 L) | `createEventBus()` factory returns `{ on, off, emit, clearAll }`. No module-level exports. `on(name, fn)` returns key string; `off(key)` unsubscribes; `emit(name, payload)` copies listener array to allow mutation during iteration, silently catches listener errors; `clearAll()` wipes all listeners. 6 typed event payloads: `WorkflowStartedEvent`, `WorkflowAgentFailedEvent`, `WorkflowPhaseEvent`, `WorkflowLogEvent`, `WorkflowFinishedEvent`, `WorkflowStepCheckpointEvent` |
| `src/meta.ts` (309 L) | Recursive-descent parser for `export const meta = { ... }` data literal. `parseMeta(script)`: matches `META_START_RE`, finds balanced `}` via `findBalancedClose()` (comment-aware, quote-aware), parses the object literal via `parseDataLiteral()` → recursive `readValue()`/`readObject()`/`readArray()`/`readString()`/`readNumber()`/`matchKeyword()`. Validates required `name` and `description` (non-empty strings). Returns `{ ok: true, meta, body }` with whitespace-preserving body transformation. No `eval`, `new Function`, or `vm` — pure string parsing |
| `src/builtin-registry.ts` (75 L) | Lazy-loaded builtin registry: `REGISTRY` is null-prototype object; `registerBuiltin(name, loader)` stores a loader function; `loadBuiltin(name)` calls loader and returns `BuiltinEntry { name, description, whenToUse, phases, script }`. 4 lazy loaders: `loadDeepResearch()`, `loadPlan()`, `loadTdd()`, `loadRefactor()` — each does `import("../builtin/{name}.ts")` to avoid bundling all builtins eagerly |
| `src/schema.ts` (47 L) | SQL DDL: `workflow_runs` (19 columns: id, name, status, running, succeeded, failed, current_phase, parent_run_id, args, script_sha, agent_timeout_ms, max_steps, max_tokens, max_wall_clock_ms, per_step_timeout_ms, error, time_created, time_updated), `workflow_steps` (10 columns: run_id, step_index, kind, input_prompt, output_result, cost_tokens, duration_ms, error, timestamp, PRIMARY KEY (run_id, step_index), FOREIGN KEY CASCADE). 2 indexes: `idx_wf_steps_run`, `idx_wf_runs_status`. PRAGMA journal_mode=WAL on apply |
| `src/api.ts` (24 L) | Public API type re-exports from `types.ts`: `AgentOptions`, `AgentResult`, `AgentFailureReason`, `WorkflowConfig`. Type interfaces for primitives: `AgentFn` (never-throw), `ParallelFn` (bubbles throws), `PipelineFn` (sequential, bubbles throws) |
| `src/types.ts` (183 L) | All TypeScript types: `WorkflowStatus` (6 union), `WorkflowRun` (SQL row), `WorkflowStep` (SQL row), `JournalEvent` (3 discriminated by `t`), `RunEntry` (in-memory), `WorkflowConfig` (5 budget fields), `SandboxConstraints` (3 fields), `AgentOptions` (8 fields), `AgentResult` (null|string|object), `AgentFailureReason` (5 const values), `WorkflowStartInput` (5 fields), `WorkflowStatusOutput` (10 fields), `WorkflowOutcome` (7 fields), `WorkflowError` class. Exports `DEFAULT_WORKFLOW_CONFIG` and `DEFAULT_SANDBOX_CONSTRAINTS` |
| `builtin/deep-research.ts` (478 L) | **Largest builtin** — 6-phase research orchestrator. Exports `meta` (TypeScript object) and `source` (string, ~280 LOC guest JS). Phases: Plan (split question into 3-7 search lines), Search (one agent per line, parallel), Extract (de-dup URLs via canonURL, read top 15 sources, extract checkable facts), Group (fold identical claims to avoid redundant crosscheck), Crosscheck (3-juror adversarial per fact, 2-reject quorum drops), Report (rank survivors, merge, cite). Tunables: JURY_SIZE=3, REJECT_QUORUM=2, SOURCE_BUDGET=15, FACT_CAP=25. Uses `pipeline()` for Search→Extract and nested `parallel()` for reads + crosscheck |
| `builtin/plan.ts` (236 L) | 4-phase planning: Scope (clarification paragraph + 3-5 success criteria), Decompose (5-15 ordered steps with ids/titles/descriptions), Estimate (deps + parallel_group + est_minutes per step, cycle detection), Output (structured plan object with total_minutes and parallel_groups). Auto-retry on Decompose if < MIN_STEPS. Tunables: MIN_STEPS=5, MAX_STEPS=15 |
| `builtin/tdd.ts` (251 L) | 5-phase TDD artifact generation: Spec (3-5 acceptance criteria as given/when/then test names), Red (full failing test file content), Green (minimal implementation to pass tests), Refactor (notes + optional before/after patches, not auto-applied), Verify (returns test+impl as artifacts). Tunables: CRITERIA_MIN=3, CRITERIA_MAX=5. Generates artifacts, does NOT execute tests |
| `builtin/refactor.ts` (253 L) | 4-phase code-smell proposer: Scan (glob target, pick top 5 files by complexity, read contents), Diagnose (3-7 concrete smells: kind/location/description/severity), Propose (1-5 before/after patches with title/reason/risk/addresses_smell), Output (returns smells + proposals for user review, does NOT auto-apply). Requires args.target + args.workspace. Tunables: MAX_FILES_READ=5, SMELLS_MIN=3, PROPOSALS_MIN=1 |
