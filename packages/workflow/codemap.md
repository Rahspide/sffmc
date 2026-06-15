# packages/workflow/

## Responsibility

Sandboxed JavaScript orchestrator for 200+ step multi-phase workflows. Lets an OpenCode agent spawn long-running, durable workflows written in a sandboxed JS dialect, with agent/parallel/pipeline primitives, 5-layer budget enforcement, 3-layer state (SQLite + per-run script + JSONL journal), and resume-after-crash via SHA-256 edit detection. Runs inside quickjs-emscripten WASM with no Node.js surface.

## Design Patterns

**Sandbox (quickjs-emscripten WASM)** — Guest scripts run in an isolated QuickJS context with no Node/Web APIs. Host functions (`agent`, `parallel`, `pipeline`, `workflow`, `phase`, `log`, `readFile`, `writeFile`, `glob`, `exists`) are injected as guest globals via the sync-promise bridge (`newPromise` + `executePendingJobs`). The PRELUDE defines `parallel`/`pipeline` guest-side to avoid host round-trips. Determinism is hardened: `Date` deleted, `Math.random` replaced with seeded mulberry32 PRNG, `WeakRef`/`FinalizationRegistry` removed.

**3-Layer State** — (1) SQLite row (`workflow_runs`) for status and counters; (2) per-run `.js` script file for the source text; (3) JSONL journal (`{runID}.jsonl`) for agent results, log entries, and phase markers. Journal enables replay: on resume, agent calls with the same deterministic key (sha256 of canonical prompt+opts+occurrence) return cached results, skipping re-execution. SHA-256 of script body on resume detects edits — if changed, journal is cleared.

**5-Layer Budget** — Lifecycle cap (1000 agents total), concurrent cap (16 via Promise-based semaphore), depth cap (8 nesting levels), wall-clock deadline (12h for sandbox, 1h default per-run), token cap (2M tokens across all agents).

**3 Primitives** — `agent()` (never-throw: returns null on failure), `parallel()` (Promise.all of thunks, fails loud on throws), `pipeline()` (sequential stages over items). All called from guest scripts; `parallel`/`pipeline` are defined guest-side in the PRELUDE for zero host round-trip overhead.

**4 Builtins** — `deep-research` (6-phase adversarial jury), `plan` (4-phase structured plan), `tdd` (5-phase artifact gen), `refactor` (4-phase code-smell proposer). Lazy-loaded via `builtin-registry.ts` on first `workflow({operation:"run", name:"..."})`.

**Never-Throw Contract** — `agent()` resolves to `null` on any failure (over-cap, spawn-reject, timeout, actor-error, no-deliverable). The sandbox `runSandboxed()` also never throws — returns `null` on any error. Only script-level logic errors propagate as throws (fail loud).

**Deferred Outcome + AbortController** — Each run has a `Promise<WorkflowOutcome>` and `AbortController`. `wait` resolves when the outcome settles; `cancel` aborts then resolves. Flush scheduling (250ms debounced) batches DB counter updates.

**Semaphore + Lock** — In-process Promise-based semaphore limits concurrent agent calls to 16. Named lock (`acquireLock`) serializes resume operations per runID.

**Lexical Jail** — Workspace file primitives (`readFile`, `writeFile`, `glob`, `exists`) resolve all paths against a configurable workspace root. Paths that escape the root (lexical check via `startsWith`) are rejected. No symlink resolution — lexical only.

## Data & Control Flow

```
workflow tool call (run/status/wait/cancel/resume)
  → tool.ts execute() dispatches to WorkflowRuntime
  → runtime.start() resolves script (builtin/inline/file/saved)
  → creates RunEntry, launches in sandbox (runSandboxed)
  → guest script calls primitives:
      agent() → semaphore → cap checks → callLLM → journal append → emit event
      parallel() → guest PRELUDE Promise.all → host thunks
      pipeline() → guest PRELUDE sequential stages
      workflow() → spawnChildWorkflow → recursive run
      phase()/log() → journal append + emit event
  → on completion: emit workflow:finished, persist status
  → journal replay on resume: SHA check → cached results or re-execute
```

## OpenCode Hooks

| Hook | Registration | Purpose |
|------|-------------|---------|
| `config` | `index.ts` default export → `server()` | Recovers orphaned workflows on startup: any `workflow_runs` row with status `running` not in the in-memory map gets marked `crashed` |
| `tool` | `index.ts` default export → `server()` → `tool:` block | Registers `workflow` tool with 5 operations (run/status/wait/cancel/resume) |

## Integration Points

| Dependency | Purpose |
|-----------|---------|
| `quickjs-emscripten` (npm, 0.32.0) | WASM-based QuickJS runtime for sandboxed guest script execution |
| `yaml` (npm, ^2.5.0) | YAML parsing (reserved for future config, not yet exercised) |
| `bun:sqlite` | SQLite database for workflow state persistence |
| `node:crypto` | SHA-256 (journal keys, script edit detection), SHA-1 (PRNG seed from runID), randomBytes (runID generation) |
| `node:fs` / `node:fs/promises` | Script file IO, journal JSONL append, workspace file primitives |
| `node:path` | Path resolution for workspace jail, saved workflow lookup |
| `node:os` | `homedir()` for XDG data directory, `cpus().length` for default concurrency |
| OpenCode SDK | `ctx.client.session.message()` for LLM calls (bypasses Max Mode + tool.execute hooks) |

## Public API

Exported from `src/index.ts`:

```ts
// Classes
export { WorkflowRuntime }         // Core runtime: start/status/wait/cancel/resume/list/recoverOrphanedWorkflows
export { WorkflowPersistence }     // Static persistence: CRUD, journal, checkpoints, dataDir

// Functions
export { parseMeta }               // Parse `export const meta = { ... }` from script source
export { resolveWorkflow, isInlineScript }  // Resolve workflow by name/path/inline
export { getRuntime, setRuntime }  // Late-bound runtime singleton
export { registerBuiltin, getBuiltin, loadBuiltin, listBuiltins }  // Builtin registry
export { on, off, emit, clearAll } // Event bus

// Constants
export { DEFAULT_WORKFLOW_CONFIG, DEFAULT_SANDBOX_CONSTRAINTS }

// Types
export type { WorkflowStatus, WorkflowRun, WorkflowStep, JournalEvent, RunEntry,
              WorkflowConfig, SandboxConstraints, AgentOptions, AgentResult,
              AgentFailureReason, WorkflowStartInput, WorkflowStatusOutput,
              WorkflowOutcome, WorkflowError }
```

### 5 Workflow Tool Operations

| Operation | Signature | Behavior |
|-----------|-----------|----------|
| `run` | `{ name?, script?, args?, workspace? }` | Resolves script (builtin→saved→file→inline), persists, launches sandbox, returns `{ runID }` |
| `status` | `{ run_id }` | Returns live stats or DB row; unknown ID → `{ status: "crashed" }` |
| `wait` | `{ run_id, timeout_ms? }` | Blocks until outcome or timeout; no timeout → waits forever |
| `cancel` | `{ run_id }` | Aborts sandbox, marks status `cancelled`, resolves outcome |
| `resume` | `{ run_id, agent_timeout_ms? }` | Reloads from DB+journal, checks SHA for edits, re-launches |

## Builtins

| Name | Phases | Description | Tunables |
|------|--------|-------------|----------|
| `deep-research` | Plan → Search → Extract → Group → Crosscheck → Report | 6-phase research with 3-juror adversarial crosscheck per fact | JURY_SIZE=3, REJECT_QUORUM=2, SOURCE_BUDGET=15, FACT_CAP=25 |
| `plan` | Scope → Decompose → Estimate → Output | Structured plan: scope clarification, 5-15 ordered steps with deps/parallel groups/time estimates | MIN_STEPS=5, MAX_STEPS=15 |
| `tdd` | Spec → Red → Green → Refactor → Verify | TDD artifact generation: acceptance criteria → failing tests → minimal impl → refactor notes → artifacts | CRITERIA_MIN=3, CRITERIA_MAX=5 |
| `refactor` | Scan → Diagnose → Propose → Output | Reads target files, diagnoses 3-7 smells, proposes 1-5 before/after patches (advisory, not auto-applied) | MAX_FILES_READ=5, SMELLS_MIN=3, PROPOSALS_MIN=1 |

## State Machine

```
pending → running ──→ completed
                 ├──→ failed (agent error, script error, structural fault)
                 ├──→ cancelled (user abort)
                 ├──→ budget_exceeded (token cap or deadline)
                 └──→ crashed (process restart during running, auto-marked by recoverOrphanedWorkflows)
```

## Budget

| Layer | Default | Enforced By |
|-------|---------|-------------|
| Lifecycle agents | 1000 | `MAX_LIFECYCLE_AGENTS` constant, checked in `spawnAgent()` |
| Concurrent agents | 16 (min of 16, 2×CPU cores) | Promise-based semaphore in `WorkflowRuntime` |
| Nesting depth | 8 | `MAX_DEPTH_DEFAULT`, checked per agent call |
| Wall-clock (sandbox) | 12h | `SCRIPT_DEADLINE_MS`, hard kill via `Promise.race` in `runSandboxed()` |
| Wall-clock (per-run) | 1h | `maxWallClockMs` in `WorkflowConfig`, checked via `deadlineMs` |
| Tokens (all agents) | 2M | `MAX_TOKENS_DEFAULT`, checked per agent call against cumulative `tokensUsed` |
| Per-agent timeout | 120s | `perStepTimeoutMs`, passed to LLM call |
| Sandbox memory | 64 MiB | `rt.setMemoryLimit()` in `runSandboxed()` |
| Sandbox instructions | 5M | `shouldInterruptAfterDeadline` interrupt handler |
| Max steps (per-run) | 200 | `maxSteps` in `WorkflowConfig`, checked before each agent spawn |

## Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry point: registers OpenCode hooks, wires observability, re-exports all public API |
| `src/runtime.ts` | WorkflowRuntime: start/status/wait/cancel/resume/list, semaphore, lock, agent spawning with budget checks, journal dedup, LLM calls, child workflows, flush scheduling |
| `src/sandbox.ts` | quickjs-emscripten sandbox: runSandboxed(), PRELUDE injection, host function bridging, deterministic hardening, concurrent pump, deadline enforcement |
| `src/tool.ts` | workflowTool definition: 5 operations with JSON schema, execute() dispatches to runtime via runtime-ref |
| `src/persistence.ts` | WorkflowPersistence: SQLite CRUD, base62 runID generation, script SHA, journal IO (sync/async JSONL), step checkpoints, canonical key derivation |
| `src/resolve.ts` | resolveWorkflow(): inline detection, file path resolution, saved workflow lookup in .sffmc/workflows/ and .claude/workflows/ |
| `src/workspace.ts` | Lexical jail: setJail, resolveInWorkspace, readFile_/writeFile_/exists/glob — all confined to workspace root |
| `src/events.ts` | EventBus: on/off/emit/clearAll with 6 event types (started, agent_failed, phase, log, finished, step_checkpoint) |
| `src/meta.ts` | parseMeta(): recursive-descent parser for `export const meta = { ... }` — no eval, comment-aware, validates name+description |
| `src/builtin-registry.ts` | Lazy-loaded builtin registry: registerBuiltin/getBuiltin/loadBuiltin/listBuiltins with 4 builtins |
| `src/runtime-ref.ts` | Late-bound singleton WorkflowRuntime ref; breaks circular import between tool.ts and runtime.ts |
| `src/schema.ts` | SQL DDL: workflow_runs (19 cols), workflow_steps (10 cols), 2 indexes, WAL mode |
| `src/api.ts` | Public API type re-exports: AgentFn, ParallelFn, PipelineFn |
| `src/types.ts` | All TypeScript types and default configs: WorkflowStatus, WorkflowRun, WorkflowStep, JournalEvent, RunEntry, WorkflowConfig, SandboxConstraints, AgentOptions, AgentResult, etc. |
| `builtin/deep-research.ts` | 6-phase research orchestrator with 3-juror adversarial jury; exports meta + source string (~280 LOC) |
| `builtin/plan.ts` | 4-phase planning: Scope → Decompose → Estimate → Output; auto-retry on too-few-steps |
| `builtin/tdd.ts` | 5-phase TDD artifact gen: Spec → Red → Green → Refactor → Verify; generates test+impl files |
| `builtin/refactor.ts` | 4-phase code-smell proposer: Scan → Diagnose → Propose → Output; advisory patches, no auto-apply |

## Tests

| File | Count | Coverage |
|------|-------|----------|
| `src/index.test.ts` | 15 | Integration: agent never-throw, parallel/pipeline propagation, lifecycle, events, phases |
| `src/sandbox.test.ts` | 20 | Sandbox isolation: prelude, hooks, determinism, deadline, memory |
| `tests/foundation.test.ts` | 50 | Type/persistence/resolve unit tests |
| `tests/integration.test.ts` | 4 | Multi-step end-to-end |
| `tests/e2e-200-steps.test.ts` | 5 | Long-horizon: 200 sequential agents, lifecycle cap trip, token cap trip, parallel/pipeline correctness |

Total: 94 tests across 5 files.
