# MiMo-Code — Developer Reference

A standalone reference describing Xiaomi MiMo-Code's features, the workflow
engine, the tool layer, memory, plugins, configuration, and sandboxing — as
documented in the project's own source tree and public repository.

> **Scope.** This document is purely a reference for what MiMo-Code offers and
> how its API is shaped. It quotes source code and configuration shapes
> verbatim, with file:line citations throughout. It does not compare, contrast,
> or otherwise engage with any other system.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Workflow Engine](#2-workflow-engine)
3. [LLM Tools (Tool Layer)](#3-llm-tools-tool-layer)
4. [Built-in Workflows](#4-built-in-workflows)
5. [Memory / Context](#5-memory--context)
6. [Plugins / Hooks](#6-plugins--hooks)
7. [Configuration & Persistence](#7-configuration--persistence)
8. [Concurrency & Determinism](#8-concurrency--determinism)
9. [Sandbox Security Model](#9-sandbox-security-model)
10. [Adoption Patterns](#10-adoption-patterns)
11. [Comparisons (Within MiMo's Own Framing)](#11-comparisons-within-mimos-own-framing)
12. [References](#12-references)

---

## 1. Overview

### What MiMo-Code is

MiMo-Code is a terminal-native AI coding assistant forked from OpenCode. Its
README opens with the framing *"An open-source AI coding agent with
cross-session memory"* (`README.md:7`) and the GitHub repo description reads
*"MiMo Code: Where Models and Agents Co-Evolve"*
(https://github.com/XiaomiMiMo/MiMo-Code, GitHub API).

The project is published by XiaomiMiMo (GitHub organization id 208276378). The
repository was created on **2026-06-10**, the latest release at the time of
this document is **v0.1.1** (tagged 2026-06-15), and the main branch has been
actively pushed to as recently as 2026-06-19. As of the snapshot:

| Stat | Value | Source |
| --- | --- | --- |
| Stars | 9,921 | GitHub API `stargazers_count` |
| Forks | 914 | GitHub API `forks_count` |
| Watchers | 60 | GitHub API |
| Open issues | 413 | GitHub web UI |
| Open PRs | 96 | GitHub web UI |
| Commits on `main` | 41 | GitHub web UI |
| Default branch | `main` | GitHub API |
| License | MIT | `LICENSE:1-22` + GitHub API `license.spdx_id` |
| Description | MiMo Code: Where Models and Agents Co-Evolve | GitHub API |
| Topics | `ai`, `ai-agents`, `cli`, `mimo`, `mimo-code` | GitHub API |

Top contributors (GitHub API `/contributors`):

| GitHub login | Contributions |
| --- | --- |
| `MiMoHardFather` | 19 |
| `yanyihan-xiaomi` | 9 |
| `qiaozongming` | 9 |
| `bwshen-mi` | 2 |
| `ChuanfengZhang` | 1 |

### Architecture (high-level)

The repository is a monorepo of 18 packages, of which the load-bearing ones are:

| Package | Purpose | Source root |
| --- | --- | --- |
| `app` | TUI/CLI app entrypoint | `packages/app/` |
| `console` | Console/web client | `packages/console/` |
| `containers` | Containerised environments | `packages/containers/` |
| `desktop` | Desktop client | `packages/desktop/` |
| `enterprise` | Enterprise edition hooks | `packages/enterprise/` |
| `extensions` | Extension glue | `packages/extensions/` |
| `function` | Function/service entrypoints | `packages/function/` |
| `identity` | Auth/identity plumbing | `packages/identity/` |
| `opencode` | Core server: agents, providers, tools, workflows, memory, MCP, plugins | `packages/opencode/` |
| `plugin` | Plugin/SDK package (published to npm as `@mimo-ai/plugin`) | `packages/plugin/` |
| `script` | Build/scripting helpers | `packages/script/` |
| `sdk` | Generated OpenAPI client | `packages/sdk/` |
| `shared` | Cross-package utilities (e.g. XDG path resolution) | `packages/shared/` |
| `slack` | Slack integration | `packages/slack/` |
| `storybook` | UI storybook | `packages/storybook/` |
| `ui` | UI primitives | `packages/ui/` |

(Plus `function/` package whose contents are split between `script` and
`shared`.)

### Technical stack

| Concern | Choice | Evidence |
| --- | --- | --- |
| Language | TypeScript (strict, native preview) | `packages/opencode/tsconfig.json`; `package.json` uses `@typescript/native-preview` |
| Effect system | `effect` (Effect.gen / Layer / Scope) | `packages/opencode/src/workflow/runtime.ts:1-25` |
| Schema | `zod` (with `.strictObject`, `.discriminatedUnion`) | `packages/opencode/src/tool/workflow.ts:12-51` |
| ORM / migrations | `drizzle-orm` + `drizzle-kit` | `packages/opencode/drizzle.config.ts:1`; `packages/opencode/migration/` |
| Database | SQLite (WAL mode) | `packages/opencode/src/storage/` |
| Runtime | Bun | `package.json` scripts use `bun`; `quickjs-emscripten` is the embedded JS engine for workflows (`sandbox.ts:1-7`) |
| File watching | `@parcel/watcher` (inotify / fs-events / windows) | `packages/opencode/src/file/watcher.ts:1-50` |
| LLM SDK | `ai` (Vercel AI SDK) with provider adapters | `packages/opencode/package.json:122-141` (`@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, `@ai-sdk/xai`, `@ai-sdk/openrouter`, `@ai-sdk/alibaba`, `@ai-sdk/gateway`, …) |
| Plugin runtime | Workspace-local `@mimo-ai/plugin` package | `packages/plugin/src/index.ts` |

### Provider set

Provider IDs are statically enumerated
(`packages/opencode/src/provider/schema.ts:13-25`):

```ts
opencode, anthropic, openai, google, googleVertex, githubCopilot,
amazonBedrock, azure, openrouter, mistral, gitlab
```

In addition the runtime dynamically registers `xiaomi` (custom MiMo Platform
auth) and `codex`, plus the optional `copilot`, `gitlab`, and `poe` auth
providers loaded as plugins (`packages/opencode/src/plugin/index.ts:124-139`).

The default model on install is **MiMo Auto** ("anonymous channel, zero
configuration" — `README.md:36`). The npm CLI binary is `mimo`
(`packages/opencode/package.json:14`).

---

## 2. Workflow Engine

The workflow engine lives in `packages/opencode/src/workflow/` (≈ 2,450 LOC
across 10 files, plus one built-in script). The public surface to the LLM is
the **`workflow` tool** (see §3), which drives the **WorkflowRuntime** Effect
service.

### 2.1 Runtime service surface

The runtime is built as a `Layer` providing
`@opencode/WorkflowRuntime` (`packages/opencode/src/workflow/runtime.ts:142`).
Its `Interface` (`runtime.ts:131-140`) is:

```ts
interface Interface {
  start(input: StartInput): Effect<{ runID: string }>
  status(input: { runID: string }): Effect<{
    status: RunStatus | "unknown"
    agentCount: number
    currentPhase?: string
  }>
  wait(input: { runID: string; timeoutMs?: number }): Effect<RunOutcome>
  cancel(input: { runID: string }): Effect<void>
  list(input?: { sessionID?: SessionID }): Effect<RunSummary[]>
  resume(input: { runID: string; agentTimeoutMs?: number }): Effect<{
    runID: string
    resumed: boolean
  }>
}
```

(`runtime.ts:131-140`).

`RunOutcome` is a sum type (`runtime.ts:46-50`):

```ts
type RunOutcome =
  | { status: "completed"; result: unknown }
  | { status: "failed"; error: string }
  | { status: "cancelled" }
```

### 2.2 `agent(prompt, opts)` — the primary guest global

The `agent` host function is the only way for a workflow script to spawn a
subagent. Signature (declared at `runtime.ts:798`):

```ts
const agent: HostFn = (prompt: unknown, opts?: unknown) => /* ... */
```

`opts` is typed structurally (`runtime.ts:114-129`):

```ts
interface AgentOpts {
  agentType?: string
  tools?: readonly string[]
  model?: string                  // "provider/model" or group name
  schema?: Record<string, unknown>
  isolation?: "worktree"
  label?: string                  // observability tag
  phase?: string                  // observability tag
  timeoutMs?: number              // per-call wall-clock cap
}
```

**Return value contract.** `agent()` is **never-throw** to the guest:
every failure path resolves to `null` (`runtime.ts:798-873`):

- Successful spawn returning structured output → the validated object.
- Successful spawn returning prose → its `finalText`.
- Spawn rejected → `null`.
- Outcome.status !== "success" → `null`.
- No deliverable produced → `null`.
- Wall-clock timeout (per-call `timeoutMs` or run-level `agentTimeoutMs`) →
  `null`, and the child is cancelled (`runtime.ts:476-511`).
- Lifecycle cap exceeded → `null` and a `WorkflowAgentFailed` event with
  reason `over-cap` is emitted (`runtime.ts:826-831`).

The full enumeration of failure-reason tags is
`WorkflowAgentFailed.reason` (`events.ts:49`):

```ts
reason: z.enum([
  "over-cap", "spawn-reject", "timeout", "actor-error", "no-deliverable"
])
```

### 2.3 `parallel([tasks])` and `pipeline([items, ...stages])`

Both are baked into the sandbox prelude (`sandbox.ts:40-64`):

```js
globalThis.parallel = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t)));

globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)),
                  Promise.resolve(item))));
```

`parallel(thunks)` runs each thunk concurrently; **a throwing thunk rejects
the whole batch** so failures fail loud rather than silently becoming `null`s
(`sandbox.ts:34-39`). The comment is explicit:

> Pure-guest helpers. parallel/pipeline do NO throttling — concurrency is
> enforced by the host semaphore inside the agent() hook. They also do NOT
> catch: a throwing thunk/stage rejects the batch (fails loud with the guest
> stack).

`sandbox.test.ts:180-184` verifies this:

```ts
test("a throwing thunk in parallel rejects the batch (fails loud, message survives)",
  async () => {
    const hooks = { agent: async () => { throw new Error("boom-thunk") } }
    const body  = `return await parallel([() => agent("a")])`
    await expect(evalScript(body, hooks)).rejects.toThrow(/boom-thunk/)
  })
```

`pipeline(items, ...stages)` runs each item through all stages with **no
inter-stage barrier** — later items can overtake earlier items between stages
(`sandbox.test.ts:186-193`, `workflow.txt:12`).

### 2.4 `workflow(nameOrScript, args?, opts?)` — nested invocation

Inside a workflow script, `workflow()` mints a child run, awaits its outcome,
and resolves to either the child's `result` or `null`. Signature
(`runtime.ts:897-1013`):

```ts
const workflowHook: HostFn = (
  nameOrScript: unknown,
  childArgs?: unknown,
  opts?: unknown,
) => /* Promise */
```

- **Inline form.** If the first argument is a string containing
  `export const meta =`, it is treated as an inline script
  (`resolve.ts:9-11`).
- **Saved form.** Otherwise the name is resolved against
  `.mimocode/workflows/<name>.js` (preferred) or
  `.claude/workflows/<name>.js`, walking upward from the workspace to the
  worktree (`resolve.ts:22-29`).
- **args** is passed to the child as its `args` global.
- **opts.workspace** narrows (but does not widen) the child's workspace
  (`runtime.ts:963`). Escape via lexical `..` throws and fails the parent
  loud (`workspace.ts:19-25`).
- **opts.maxConcurrentAgents** narrows (but does not widen) the child's own
  semaphore (`runtime.ts:964`).

#### Cycle and depth guards

Two structural errors fail the parent run loud
(`runtime.ts:940-947`):

```ts
if (depth + 1 > maxDepth) {
  return yield* Effect.die(new Error(
    `${WORKFLOW_STRUCTURAL_ERROR}: workflow nesting exceeds maxDepth (${maxDepth})`))
}
if (lineage.includes(childName)) {
  return yield* Effect.die(new Error(
    `${WORKFLOW_STRUCTURAL_ERROR}: workflow cycle detected: ${childName} is already an ancestor`))
}
```

Cycle detection is asymmetric: **saved names key by name only** (so saved
`A → A` with different args is still a cycle), while **inline bodies key on
content+args hash** (so an inline body that re-invokes itself with different
args is bounded only by `maxDepth`). This is documented in `workflow.txt:25`.

The default `maxDepth` is 8 (`runtime.ts:447`; `config.ts:395`).

### 2.5 `phase(title)` and `log(message)` — observability

Both are host functions. `phase(title)` updates the current phase on the
`RunEntry`, persists it via `WorkflowPersistence.recordPhase`, appends a
journal entry, and publishes a `WorkflowPhase` bus event
(`runtime.ts:875-881`).

```ts
const phase: HostFn = (title: unknown) => {
  entry.currentPhase = String(title)
  Effect.runFork(WorkflowPersistence.recordPhase({ runID, phase: String(title) }))
  Effect.runFork(WorkflowPersistence.appendJournal(runID,
    { t: "phase", title: String(title), pass }))
  Effect.runFork(bus.publish(WorkflowPhase,
    { sessionID: input.sessionID, runID, title: String(title) }))
  return undefined
}
```

`log(message)` only appends to the journal and emits a `WorkflowLog` event —
it does NOT update `currentPhase` (`runtime.ts:883-887`).

### 2.6 The file primitives

Four sandbox globals expose the workspace (`runtime.ts:1015-1024`):

```ts
const hooks: Record<string, HostFn> = {
  agent,
  phase,
  log: logHook,
  workflow: workflowHook,
  readFile: fileHooks.readFile,
  writeFile: fileHooks.writeFile,
  glob: fileHooks.glob,
  exists: fileHooks.exists,
}
```

All four are implemented in `workspace.ts:30-68` and jailed to the workspace
root by a **lexical** check (no `..` or absolute escape). They auto-create
parent dirs on write.

### 2.7 Sandbox — `quickjs-emscripten`

The sandbox is built on [`quickjs-emscripten`](https://github.com/justjake/quickjs-emscripten),
imported as `quickjs-emscripten` in `package.json:120` and used in
`sandbox.ts:1-7`:

```ts
import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten"
```

The full `evalScript(body, hooks, opts)` lifecycle is in `sandbox.ts:77-223`.
The strict constraints are stated in the doc-comment at `sandbox.ts:66-77`:

> Hard constraints encapsulated here (validated by the 2026-06-01 spike):
> - sync-promise bridge (newPromise + executePendingJobs), NOT asyncify
> - a concurrent pump alongside resolvePromise so host-promises settle
> - every QuickJSHandle disposed before context dispose (else process abort)

#### Memory limit

Default 64 MiB (`sandbox.ts:27-28`):

```ts
const DEFAULT_MEMORY = 64 * 1024 * 1024
```

Configurable per call via `SandboxOptions.memoryLimitBytes`.

#### Wall-clock deadline

Default 12 hours (`sandbox.ts:27`, `runtime.ts:29`):

```ts
const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000
const SCRIPT_DEADLINE_MS  = 12 * 60 * 60 * 1000
```

Enforced both in-guest (`rt.setInterruptHandler(shouldInterruptAfterDeadline(...))`,
`sandbox.ts:81`) and host-side as a `Promise.race` against `vm.resolvePromise`
(`sandbox.ts:191-209`).

### 2.8 State persistence — three layers

Every run's state lives in three coordinated places:

| Layer | Location | Format | Lifecycle |
| --- | --- | --- | --- |
| SQLite row | `workflow_run` table | Drizzle row | One row per runID; updates on phase / counter / terminal |
| Script body | `<data>/workflow/<runID>.js` | JS source | Re-read on resume |
| Event journal | `<data>/workflow/<runID>.jsonl` | NDJSON | Append-only |

#### The `workflow_run` table

(`packages/opencode/src/workflow/workflow.sql.ts:6-30`)

```ts
export const WorkflowRunTable = sqliteTable(
  "workflow_run",
  {
    id: text().primaryKey(),
    session_id: text().$type<SessionID>().notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    status: text().$type<"running" | "completed" | "failed" | "cancelled">().notNull(),
    running:   integer().notNull().default(0),
    succeeded: integer().notNull().default(0),
    failed:    integer().notNull().default(0),
    current_phase:  text(),
    parent_actor_id: text(),
    args:            text({ mode: "json" }),
    script_sha:      text(),
    agent_timeout_ms: integer(),
    error: text(),
    ...Timestamps,
  },
  (table) => [
    index("workflow_run_session_idx").on(table.session_id),
    index("workflow_run_status_idx").on(table.status),
  ],
)
```

`recordStart` is idempotent on conflict: re-launching under the same runID
flips the row back to `"running"`, resets counters, and re-stamps
`script_sha` (`persistence.ts:123-176`).

#### The journal

Journal events (`persistence.ts:52-57`):

```ts
type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "log";   msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }
```

`pass` is a monotonically increasing integer; `loadJournal` returns the
highest `pass` it has seen, and subsequent code stores the next pass so an
appender never overwrites an in-progress result (`persistence.ts:264-282`).

There are **two** journal-append methods, with deliberately different
semantics (`persistence.ts:239-261`):

- `appendJournal` — async, used for `phase` and `log` (low volume).
- `appendJournalSync` — **synchronous, file IO** on the calling fiber. Used
  for agent results, the comment is explicit:

> Called PER-AGENT from the agent() hook the instant a spawn succeeds, so
> each result is durable on disk immediately — a mid-run process exit /
> SIGKILL / deadline leaves a journal containing every completed agent,
> which is what makes resume replay them (durability does NOT wait for run
> completion). It is SYNCHRONOUS on purpose: an Effect.promise(async fs)
> append suspends the calling fiber on a macrotask, which empirically
> starves the quickjs sandbox pump […]

### 2.9 Budget enforcement

The runtime enforces limits across five distinct axes. None of them is
configurable from the guest except through `agentTimeoutMs`.

#### Lifecycle cap (per-run, total agents)

```ts
const MAX_LIFECYCLE_AGENTS = 1000
```

(`runtime.ts:34`). Over-cap `agent()` calls return `null` and emit
`WorkflowAgentFailed` with reason `"over-cap"` (`runtime.ts:826-831`). The
comment at `runtime.ts:457-466` documents the cap rationale:

> Over-cap → null (see maxLifecycleAgents doc): warn ONCE per run so the
> dropped work is visible without spamming a log line per over-cap call.

Configurable per run via `input.maxLifecycleAgents` and globally via
`config.workflow.maxLifecycleAgents` (`config.ts:397-400`).

#### Concurrency cap (process-wide, agents in flight)

Two layers of semaphore:

- A **process-wide** semaphore sized from `config.workflow.maxConcurrentAgents`,
  defaulting to `min(16, 2 × cpuCount)` (`runtime.ts:36, 250-270`). It is
  memoized for the lifetime of the service, so a config change later does
  NOT rebuild it.
- A **per-run** semaphore that defaults to the global cap and is clamped
  `≤ global` (`runtime.ts:448-453`). A per-run `maxConcurrentAgents` can
  only narrow, never widen.

A pure JS promise semaphore (`runtime.ts:145-174`):

```ts
function makeSemaphore(max: number) {
  let active = 0
  const queue: Array<() => void> = []
  /* ... */
  return {
    run<T>(fn: () => Promise<T>): Promise<T> { /* ... */ }
  }
}
```

#### Per-agent wall-clock timeout

Each `agent()` call's await is raced against the effective per-agent timeout
(`runtime.ts:476-511`). The timeout's resolution uses a `STRAGGLER_TIMEOUT`
symbol sentinel so a `null` deliverable can be distinguished from a true
timeout (`runtime.ts:30-32, 485-510`). A timeout cancels the child and yields
`null`.

Defaults: undefined (off). Set per-run via `input.agentTimeoutMs` or per-call
via `opts.timeoutMs`.

#### Nesting depth (workflow inside workflow)

```ts
const maxDepth = input.maxDepth ?? cfg?.workflow?.maxDepth ?? 8
```

(`runtime.ts:447`). Exceeding it fails the run loud with a `WORKFLOW_STRUCTURAL_ERROR`.

#### Script wall-clock deadline

`SCRIPT_DEADLINE_MS = 12h` (`runtime.ts:29`), the absolute wall-clock cap on
the whole script body. Configurable per run via `input.scriptDeadlineMs` and
globally via `config.workflow.scriptDeadlineMs`.

### 2.10 Resume after crash — SHA-256 script edit detection

`resume(input)` (`runtime.ts:1141-1210`) re-launches a run under its
existing runID. Two invariants:

1. **In-process serialization** via `Lock.write("workflow-resume:" + runID)`
   (`runtime.ts:1163`, `util/lock.ts:72-96`) prevents two concurrent
   `resume(sameRunID)` calls from both passing the live-guard and both
   launching (which would clobber the same `runs` map entry and interleave
   into the same `.jsonl`).
2. **Cross-cycle edit detection** by SHA-256 of the script body. The script
   is hashed at launch and stamped in `workflow_run.script_sha`; on
   resume, the same hash is computed over the current script body and
   compared:

   ```ts
   const currentSha = createHash("sha256").update(script).digest("hex")
   const freshJournal = row.scriptSha !== currentSha
   ```

   (`runtime.ts:1188-1189`). On mismatch, `freshJournal: true` is passed
   into `launch`, which calls `WorkflowPersistence.clearJournal(runID)` to
   truncate the journal **before** the run starts appending
   (`runtime.ts:424-425`; `persistence.ts:284-297`).

The rationale is at `runtime.ts:1181-1187`:

> The journal keys results by {prompt, agentType, model, schema, phase}+occ,
> NOT by the script body — so a between-cycle edit would replay OLD results
> onto NEW code paths (silent divergence). Compare the persisted sha
> (stamped at the prior launch) to the CURRENT script's sha […]

### 2.11 Workflow events (bus)

Six `BusEvent`s are published (`packages/opencode/src/workflow/events.ts:1-71`):

| Event | Payload | When |
| --- | --- | --- |
| `workflow.phase`     | `{ sessionID, runID, title }`            | On every `phase(title)` call |
| `workflow.log`       | `{ sessionID, runID, message }`          | On every `log(message)` call |
| `workflow.started`   | `{ sessionID, runID, name }`             | When `launch` is called |
| `workflow.finished`  | `{ sessionID, runID, status, error? }`   | On terminal (completed/failed/cancelled) |
| `workflow.agent_failed` | `{ sessionID, runID, actorID?, agentType, label?, phase?, reason, errorMessage? }` | Whenever `agent()` resolves to `null` |
| `workflow.child_failed` | `{ sessionID, runID, childRunID, name, status, error? }` | When a child workflow's runtime (not structural) failure surfaces |

The two "failed" events are **observability-only** and do not change
`agent()`'s never-throw / null-return contract (`events.ts:30-35`,
`events.ts:55-61`).

### 2.12 Cancel / reclaim

`cancel(runID)` does the following (`runtime.ts:307-358`):

1. If status is not "running", no-op.
2. **Recurse** into child actor IDs and call `actor.cancel(..., "graceful")`
   on each.
3. **Recurse** into child worktree directories and remove each.
4. **Recurse** into child runIDs (`workflow()` sub-runs) and cancel each.
5. Flush counter state.
6. Persist `status="cancelled"`.
7. Interrupt the run fiber.
8. Resolve the run's `Deferred` with `{ status: "cancelled" }`.
9. Publish `workflow.finished` with `status="cancelled"`.

The acyclicity invariant is load-bearing — child edges are added only at
`workflow()` call time, so the cancellation graph is a tree
(`runtime.ts:331-336`).

`reclaim` is also called on **failed** terminal (deadline, script throw) so
non-success terminals leave a clean slate (`runtime.ts:1071-1074`).

### 2.13 Counter invariants

Each `agent()` call follows the exact counter discipline
(`runtime.ts:565-647`):

```
running++    // BEFORE spawn attempt
spawn()
running--    // AFTER settle
if (value !== null) succeeded++
else              failed++
```

Two paths share this discipline:

- **Shared spawn** (`spawnShared`, `runtime.ts:559-647`) — child shares the
  parent's session.
- **Isolated spawn** (`spawnIsolated`, `runtime.ts:650-796`) — child gets a
  fresh worktree; worktree is kept only on success-with-changes, otherwise
  reclaimed.

Counter state is flushed to the DB **debounced** at 250 ms per run during
the run, plus a synchronous final flush on terminal (`runtime.ts:272-305`).

### 2.14 The script body

A workflow script is plain JS that starts with a meta literal
(`packages/opencode/src/workflow/meta.ts:32-60`):

```ts
const META_START_RE = /export\s+const\s+meta\s*=\s*/

export function parseMeta(script: string): ParseResult {
  const start = META_START_RE.exec(script)
  if (!start) {
    return { ok: false, error: "workflow script must start with `export const meta = { ... }`" }
  }
  /* ... */
}
```

The `meta` literal is parsed by a hand-rolled recursive-descent reader that
**never executes** the literal — it accepts only data objects/arrays/strings/
numbers/booleans/null (no calls, no member access, no operators). The literal
is replaced with an equal-length blank so the body's line numbers are
preserved for stack traces (`meta.ts:1-18, 57-59`).

Required fields (`meta.ts:20-26, 53-55`):

```ts
type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  model?: string
}
```

- `name`, `description` are mandatory and non-empty.
- `phases` is a discoverability hint surfaced by the `workflow` tool's
  catalog renderer (`registry.ts:67-83`).
- `model` is reserved for future use.

---

## 3. LLM Tools (Tool Layer)

The tool registry lives at `packages/opencode/src/tool/registry.ts`. Tools are
registered into `ToolRegistry.tools(model)` and exposed to the LLM with both
JSON and shell invocation styles (`registry.ts:309-371`).

The full list of builtin tools (compiled with all experimental flags OFF and
non-CLI clients) is `registry.ts:231-253`:

```ts
[
  tool.invalid,                                   // always present
  tool.bash,
  tool.read,
  tool.glob,
  tool.grep,
  tool.edit,
  tool.write,
  tool.actor,                                    // subagent delegation
  tool.fetch,                                    // webfetch
  tool.search,                                   // websearch
  tool.code,                                     // codesearch
  tool.skill,
  tool.patch,                                    // apply_patch (gpt-* models only)
  tool.changedir,
  tool.plan,
  tool.memory,
  tool.history,
  tool.task,
  // tool.workflow is gated on Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL
  // tool.question is gated on Flag.MIMOCODE_CLIENT + ENABLE_QUESTION_TOOL
  // tool.lsp   is gated on Flag.MIMOCODE_EXPERIMENTAL_LSP_TOOL
]
```

### 3.1 The `workflow` tool

Source: `packages/opencode/src/tool/workflow.ts` (164 LOC), description:
`packages/opencode/src/tool/workflow.txt` (25 lines).

Tool ID: `workflow`. Schema is a `z.discriminatedUnion` over the
`operation` field (`workflow.ts:45-51`):

```ts
export const parameters = z.discriminatedUnion("operation", [
  runSchema,       // { operation: "run",    name?, script?, args?, workspace? }
  statusSchema,    // { operation: "status", run_id }
  waitSchema,      // { operation: "wait",   run_id, timeout_ms? }
  cancelSchema,    // { operation: "cancel", run_id }
  resumeSchema,    // { operation: "resume", run_id }
])
```

**Operation `run`** (`workflow.ts:83-121`):

- Either `name` (a built-in) or `script` (inline JS), never both.
- `args` is exposed to the script as the `args` global.
- `workspace` is an absolute path the script's file primitives are jailed to
  (defaults to the project worktree).
- Reads `cfg.workflow?.maxConcurrentAgents` and `cfg.workflow?.scriptDeadlineMs`
  from the Config service.
- Returns `{ runID }` immediately; the workflow runs in the background and
  the result is delivered as an inbox notification.

**Operation `status`** (`workflow.ts:122-128`): returns `{ status, agentCount,
currentPhase? }`.

**Operation `wait`** (`workflow.ts:130-136`): blocks until the run completes
or `timeout_ms` elapses; returns the `RunOutcome` shape.

**Operation `cancel`** (`workflow.ts:138-144`): graceful cancel.

**Operation `resume`** (`workflow.ts:146-153`): re-launches the run under
the same runID; if not resumable, returns `{ resumed: false }`.

#### Late-bound WorkflowRuntime reference

The tool cannot take a hard `WorkflowRuntime.Service` Layer dependency (that
would force every layer that builds the registry to provide it). Instead it
uses a module-local mutable reference (`runtime-ref.ts:1-18`):

```ts
export const workflowRef: {
  current: WorkflowRuntimeInterface | undefined
} = { current: undefined }
```

The runtime populates it on layer init and clears it on finalizer
(`runtime.ts:1216-1221`); the tool reads `workflowRef.current` and throws a
clear error if undefined (`workflow.ts:65-75`).

### 3.2 The `actor` tool — subagent delegation

Source: `packages/opencode/src/tool/actor.ts` (803 LOC).

The `actor` tool is the LLM-facing interface for spawning subagents. Tool
ID: `actor`. Schema (per `actor.txt:14-31`):

| Action | Required | Optional |
| --- | --- | --- |
| `run` | `subagent_type`, `description`, `prompt` | `actor_id`, `timeout_ms`, `command`, `context` (`none`/`state`/`full`), `output_schema` |
| `spawn` | `subagent_type`, `description`, `prompt` | `actor_id`, `command`, `context`, `output_schema` |
| `status` | `actor_id` | — |
| `wait` | `actor_id` | `timeout_ms` |
| `cancel` | `actor_id` | — |
| `send` | `to_actor_id`, `content` | `to_session_id`, `type` |

Key differences vs the workflow engine:

- `run` blocks and returns the result inline; `spawn` returns `actor_id`
  immediately for background work (`actor.txt:79`).
- `context` controls what the subagent sees of the parent:
  `none` (default — clean context), `state` (checkpoint summaries),
  `full` (full conversation).
- `task_id` binds the subagent to a tracked task; on completion the
  subagent's findings get written to `tasks/<TID>/progress.md`
  (`actor.txt:61-74`).

The `output_schema` field is passed as a structured-output JSON schema to the
LLM (`workflow.ts:601, 722`).

### 3.3 The `task` tool — task tracker (NOT subagent delegation)

Source: `packages/opencode/src/tool/task.ts` (456 LOC). Tool ID: `task`.

This tool manages a **tree of in-session tasks**, not subagent delegation.
Schema (`task.ts:111-130`):

```ts
const parameters = z.strictObject({
  operation: z.discriminatedUnion("action", [
    createOperation,   // action: "create", summary, parent_id?, session_id?
    listOperation,     // action: "list",   status?, include_terminal?, ...
    getOperation,      // action: "get",    id, session_id?
    startOperation,    // action: "start",  id, event_summary?, ...
    blockOperation,    // action: "block",  id, event_summary
    unblockOperation,  // action: "unblock",id, event_summary
    doneOperation,     // action: "done",   id, event_summary
    abandonOperation,  // action: "abandon",id, event_summary
    renameOperation,   // action: "rename", id, summary
  ]).meta({ type: "object" }),
})
```

Task IDs follow the regex `^T\d+(\.\d+)*$` (`task/schema.ts:4`) — `T1`,
`T1.1`, `T1.2.3`, etc. Tasks have a parent pointer (`task/schema.ts:13`),
forming the tree shape referenced by the README.

Status values (`task/schema.ts:7`):

```ts
enum ["open", "in_progress", "blocked", "done", "abandoned"]
```

The tool also supports a **shell-invocation style** — `task create <summary>
--parent T1`, etc. — via the optional `shell.parse` field (`task.ts:449-453`).
When the LLM invokes via shell, a tokenizer (`shell-tokenize.ts`) splits the
command, and `parseTaskScript` maps each verb to its JSON-schema operation
(`task.ts:143-161`).

### 3.4 Other tools in the registry

| Tool | Purpose | Source file | LOC |
| --- | --- | --- | --- |
| `bash` | Run shell commands | `tool/bash.ts` | 696 |
| `bash-interactive` | Interactive shell sessions | `tool/bash-interactive.ts` | 183 |
| `read` | Read files (with truncation) | `tool/read.ts` | 327 |
| `edit` | Surgical file edits | `tool/edit.ts` | 685 |
| `write` | Write files | `tool/write.ts` | 88 |
| `multiedit` | Batch edits | `tool/multiedit.ts` | 61 |
| `glob` | Glob path matching | `tool/glob.ts` | 100 |
| `grep` | Regex search | `tool/grep.ts` | 145 |
| `webfetch` | Fetch a URL | `tool/webfetch.ts` | 199 |
| `websearch` | Web search (Exa / OpenCode / Xiaomi) | registered but source path under `tool/websearch.ts` | — |
| `codesearch` | Code-aware search | `tool/codesearch.ts` | 63 |
| `apply_patch` | OpenAI-style patch format (gpt-* only) | `tool/apply_patch.ts` | 308 |
| `lsp` | LSP integration (experimental) | `tool/lsp.ts` | 91 |
| `skill` | Load a skill (instruction bundle) | `tool/skill.ts` | 76 |
| `question` | Ask the user a question | `tool/question.ts` | 67 |
| `memory` | Search memory FTS5 index | `tool/memory.ts` | 81 |
| `history` | Conversation history lookup | `tool/history.ts` | 146 |
| `plan` | Enter/exit plan mode | `tool/plan.ts` | 90 |
| `invalid` | Sentinel for failed tool calls | `tool/invalid.ts` | 20 |
| `change-directory` | Set session CWD | `tool/change-directory.ts` | 91 |

Tool definitions use **Zod schemas** as the canonical type, then convert to
JSON Schema at LLM-facing time. The `Tool.Def` shape is
`packages/opencode/src/tool/tool.ts:37-52`:

```ts
export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: z.ZodError): string
  shell?: { description: string; parse; recover? }
}
```

Some tools expose a `shell` field: the registry can wrap them in a shell
invocation parser (`registry.ts:336-353`). The convention is:

> If `invocation_style === "shell"` and the tool has a `shell` field, the LLM
> sees the shell-style description and parser; otherwise it sees JSON-style.

### 3.5 The `registry` itself

`ToolRegistry.layer` (`registry.ts:112-380`) builds two tool lists:

- **builtin**: the static list above, gated by experimental flags.
- **custom**: discovered from
  - `<dir>/{tool,tools}/*.{js,ts}` (project-local tool files; `registry.ts:180-192`).
  - `plugin.tool.*` exports from installed plugins (`registry.ts:194-199`).

When `tools(model)` is called for a given model:

- Provider-gated filtering: `websearch` / `codesearch` only enabled for
  `opencode` / `xiaomi` (or all if `MIMOCODE_ENABLE_EXA`)
  (`registry.ts:311-320`).
- Model-gated filtering: `apply_patch` is enabled only for non-OSS,
  non-`gpt-4` GPT models; `edit`/`write` are disabled when `apply_patch` is
  enabled (`registry.ts:322-325`).
- `tool.definition` plugin hook fires per tool to mutate the description /
  parameters (`registry.ts:346`).
- Per-tool descriptions are augmented with subagent catalog
  (`actor.txt`-style), skill catalog, or workflow catalog depending on which
  tool id is being described (`registry.ts:357-361`).

---

## 4. Built-in Workflows

There is **exactly one** built-in workflow script shipped with the binary,
declared at `packages/opencode/src/workflow/builtin.ts:29`:

```ts
const SCRIPTS: { file: string; script: string }[] = [
  { file: "deep-research.js", script: DEEP_RESEARCH_SCRIPT }
]
```

The script source is embedded into the compiled binary via Bun's
`import x from "./deep-research.js" with { type: "text" }` pattern
(`builtin.ts:12-13`). The parse happens once at module load; a broken meta
fails the whole app boot (`builtin.ts:36-37`).

### 4.1 `deep-research`

Source: `packages/opencode/src/workflow/builtin/deep-research.js` (391 lines).

#### Meta

```js
export const meta = {
  name: 'deep-research',
  description: 'Deep research orchestrator — runs parallel web searches, ...',
  whenToUse: 'Use when the user wants a thorough, multi-source, fact-checked answer ...',
  phases: [
    { title: "Plan",       detail: "Break the question into search lines" },
    { title: "Search",     detail: "One web-search agent per line, in parallel" },
    { title: "Extract",    detail: "De-duplicate URLs, read the top sources, pull out checkable facts" },
    { title: "Group",      detail: "Fold facts that assert the same thing" },
    { title: "Crosscheck", detail: "Adversarial jury per fact" },
    { title: "Report",     detail: "Rank survivors by certainty, merge, and cite" },
  ],
}
```

(`deep-research.js:1-13`).

#### Tunables

```js
const JURY_SIZE      = 3   // crosscheck voters per fact
const REJECT_QUORUM  = 2   // reject votes that kill a fact; min valid votes to keep one
const SOURCE_BUDGET  = 15  // hard cap on how many URLs we actually read
const FACT_CAP       = 25  // hard cap on facts that reach crosscheck
```

(`deep-research.js:16-19`).

#### Six phases, in detail

| Phase | `agent()` calls | Pipeline behavior |
| --- | --- | --- |
| **Plan** | 1 (plan agent, `schema: PLAN_SHAPE`) | Hard barrier before search |
| **Search** | 1 per search line, in parallel (`schema: HITS_SHAPE`) | Each line's hits stream into the dedup gate |
| **Extract** | 1 per *fresh* URL (`schema: READ_SHAPE`) | De-dup by canonical URL; respect `SOURCE_BUDGET`; over-budget slots only admit `fit: high` |
| **Group** | 1 (group agent, `schema: GROUP_SHAPE`) | Barrier — gather all facts and rank first |
| **Crosscheck** | `JURY_SIZE` (3) per group, in parallel, with `model: "lite"` | Each fact needs `≥ REJECT_QUORUM` (2) valid votes and `< REJECT_QUORUM` rejects |
| **Report** | 1 (report agent, `schema: REPORT_SHAPE`) | Barrier |

#### Quorum logic

(`deep-research.js:298-309`):

```js
const cast    = rulings.filter(Boolean)
const rejects = cast.filter(v => v.reject).length
const abstain = JURY_SIZE - cast.length
const kept    = cast.length >= REJECT_QUORUM && rejects < REJECT_QUORUM
```

A fact is kept only if it was **genuinely adjudicated**: enough real votes
cast AND not enough rejects. The abstain case is handled by requiring
`cast.length >= REJECT_QUORUM`, so an all-abstain jury cannot falsely
"keep" a fact.

#### Final return shape

```js
return {
  question: TOPIC,
  ...report,
  rejected: dropped.map(f => ({ statement, tally, source })),
  sources:  sources.map(s => ({ url, tier, line, factCount })),
  stats: {
    lines: plan.lines.length,
    sourcesRead: sources.length,
    factsFound:  facts.length,
    factsChecked: judged.length,
    upheld:  upheld.length,
    dropped: dropped.length,
    afterReport: report.findings.length,
    repeatUrls:  repeats.length,
    overBudget:  overflow.length,
    agentRuns: 1 + plan.lines.length + sources.length + 1 + (judged.length * JURY_SIZE) + 1,
  },
}
```

(`deep-research.js:374-391`).

The `agentRuns` field at the bottom makes the cost auditable from the report.

### 4.2 Other "built-in workflows"

The README mentions built-in **skills** in compose mode (`README.md:86`):
"planning, execution, code review, TDD, debugging, verification, and merging".
These are **not** workflow scripts — they are skill packs surfaced by the
`skill` tool, described in §5.5 below.

### 4.3 Workflow resolution at runtime

Saved workflow names are resolved by walking up from the workspace to the
worktree, checking two subdirs in order (`resolve.ts:22-29`):

```ts
const subdirs = [".mimocode/workflows", ".claude/workflows"]
for (const found of await collectUp(name, subdirs, start, stop)) {
  return Filesystem.readText(found)
}
return null
```

The `.mimocode/workflows` directory is checked first (project-local wins
over `.claude/workflows`). Names are constrained to `^[A-Za-z0-9._-]+$` to
prevent path traversal (`resolve.ts:20-23`).

---

## 5. Memory / Context

The memory subsystem is built on a single SQLite FTS5 virtual table
(`packages/opencode/src/memory/fts.sql.ts:3-19`):

```ts
export const MemoryFtsTable = sqliteTable(
  "memory_fts",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    path: text().notNull().unique(),
    scope: text().notNull(),                        // global | projects | sessions | cc
    scope_id: text().notNull().default(""),
    type: text().notNull(),                         // free | memory | checkpoint | progress |
                                                    // notes | feedback | project | reference | user
    body: text().notNull(),
    fingerprint: text().notNull(),                  // "<size>-<mtimeMs>"
    last_indexed_at: integer().notNull(),
  },
  (table) => [
    index("memory_fts_scope_idx").on(table.scope, table.scope_id),
    index("memory_fts_type_idx").on(table.type),
  ],
)
```

The FTS index itself is built via a `bun:sqlite`-managed virtual table named
`memory_fts_idx` (referenced in `service.ts:106-108`).

### 5.1 On-disk layout

Memory files are markdown. The path layout is encoded in
`paths.ts:45-52`:

```ts
function parsePath(absPath: string): MemoryLocator | null {
  const m = absPath.match(
    /\/memory\/(global|projects|sessions)(?:\/([^/]+))?\/(.+)\.md$/)
  if (!m) return null
  const [, scope, idMaybe, keyRaw] = m
  const scope_id = scope === "global" ? "" : (idMaybe ?? "")
  return { scope: scope as Scope, scope_id, type: detectType(key), key: keyRaw }
}
```

| Scope | On-disk location | Example |
| --- | --- | --- |
| `global`    | `<data>/memory/global/<key>.md` | `<data>/memory/global/MEMORY.md` |
| `projects`  | `<data>/memory/projects/<pid>/<key>.md` | `<data>/memory/projects/<pid>/MEMORY.md` |
| `sessions`  | `<data>/memory/sessions/<sid>/<key>.md` | `<data>/memory/sessions/<sid>/checkpoint.md` |
| `cc`        | `<claude-projects>/<slug>/memory/<key>.md` | (read-only ingestion) |

The four well-known session-scoped files are documented at
`checkpoint-paths.ts:1-86`:

- `checkpoint.md` (also `checkpoint-<topic>.md` spillovers)
- `notes.md` (main-agent-only scratchpad)
- `tasks/<TID>/progress.md` (per-task journals)
- `MEMORY.md` (project memory, atomic-renamed from legacy `memory.md`)

### 5.2 Recon (index reconciliation)

`reconcile.ts:94-143` is the core walk:

1. **Collect** every `.md` file under both roots (mimo + optional CC).
2. **Diff** against the existing FTS rows by `path`.
3. **Prune** rows whose path no longer exists on disk.
4. **Index** rows whose fingerprint changed (`"${size}-${mtimeMs}"`,
   `reconcile.ts:57`) or were newly created.

Reconcile runs on search by default (`service.ts:59-65`), honoring
`cfg.checkpoint.memory_reconcile_on_search`. It also runs in the
checkpoint-writer flow (`session/checkpoint.ts:1175`).

### 5.3 FTS5 query builder

`fts-query.ts:28-37`:

```ts
export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw.match(/[\p{L}\p{N}_]+/gu)
       ?.map((t) => t.trim()).filter(Boolean) ?? []
  if (tokens.length === 0) return null
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`)
  return quoted.join(" OR ")
}
```

Key behaviors:

- Tokenises on Unicode letters, numbers, and `_` (so CJK letters match).
- Each token is **phrase-quoted**, neutralising FTS5's special characters.
- Tokens are **OR-joined** — empirically AND-joining returned zero results
  for most multi-word queries (`fts-query.ts:16-23`).
- BM25 ranking + a **relative score floor** drops common-word noise
  (`service.ts:117-133`):

  ```ts
  const fetchLimit = Math.min(limit * 3, 50)
  const topScore   = mapped[0].score
  const cutoff     = floorRatio > 0 ? topScore * floorRatio : -Infinity
  return mapped.filter((r, i) => i === 0 || r.score >= cutoff).slice(0, limit)
  ```

  The floor is **relative** (not absolute), because BM25 magnitudes are
  corpus-size-dependent. The `#1` result is always kept.

### 5.4 The `memory` tool

`packages/opencode/src/tool/memory.ts:7-20`:

```ts
const parameters = z.object({
  operation: z.enum(["search"]).default("search"),
  query:     z.string(),
  scope:     z.enum(["global", "projects", "sessions", "cc"]).optional(),
  scope_id:  z.string().optional(),
  type:      z.string().optional(),
  limit:     z.number().optional(),
})
```

The tool's "no results" branch teaches the model how to escalate (`memory.ts:38-56`):
retry with fewer distinctive terms, grep the memory dir directly for verbatim
strings the FTS tokenizer splits (URLs, ports, paths), or fall back to the
`history` tool.

### 5.5 Memory write guard

`packages/opencode/src/tool/memory-path-guard.ts:20-80` enforces that:

- The **checkpoint-writer** subagent may only write to the precise allowlist
  (`projects/<pid>/memory.md`, `sessions/<sid>/checkpoint.md`,
  `sessions/<sid>/notes.md`, `sessions/<sid>/tasks/<TID>/*.md`).
- **Other agents** cannot write `<sid>/tasks/*` (that's checkpoint-writer's
  domain).
- Free keys under valid scopes are still allowed (anything `<scope>/<scope_id>/<key>.md`).

### 5.6 Recon injection into rebuild context

When a session context needs to be rebuilt (e.g. trim-then-inject), the
`SessionCheckpoint.renderRebuildContext` API composes the rebuild prompt
(`session/checkpoint.ts:410-435`):

```ts
readonly renderRebuildContext: (
  sessionID: SessionID,
  opts?: { lastMessageInfo?: LastMessageInfo; agentID?: string },
) => Effect.Effect<string>
```

The format explicitly documented:

```
<system-reminder>Verify-before-act note...</system-reminder>
## Accumulated learnings (chronological)
### From checkpoint #1 (<topic>)
<Learning body>
...
## Current snapshot (as of checkpoint #N)
<Snapshot body>
```

Stale snapshots are intentionally dropped; the rebuild context is empty
when no checkpoints exist.

Token budgets per section are configured under `checkpoint.<section>` in
`config.ts:280-298`:

| Section | Default token cap |
| --- | --- |
| `memory_titles` | 500 |
| `global` (global memory) | 6,000 |
| `checkpoint` | 11,000 |
| `memory` | 10,000 |
| `design_decisions` (writer-side) | 3,000 |
| `open_notes` (writer-side) | 800 |

### 5.7 The `task` tree (memory's structural twin)

The task tracker is a separate but linked subsystem
(`packages/opencode/src/task/schema.ts`):

```ts
export const Task = z.object({
  id: TaskID,                                    // T1, T1.1, T1.2.3, ...
  session_id:   SessionID.zod,
  parent_task_id: TaskID.optional(),
  status: TaskStatus,                            // open | in_progress | blocked | done | abandoned
  summary: z.string(),
  owner:  z.string().optional(),
  created_at:    z.number(),
  last_event_at: z.number(),
  ended_at:      z.number().optional(),
  cleanup_after: z.number().optional(),
})
```

`task/sql.ts` holds the table; `task/registry.ts` provides the
`TaskRegistry` service that the `task` tool binds to.

---

## 6. Plugins / Hooks

The plugin SDK package is `@mimo-ai/plugin`, published from
`packages/plugin/src/index.ts`. The host that loads plugins is in
`packages/opencode/src/plugin/index.ts`.

### 6.1 The `Hooks` interface

The full hook surface is `packages/plugin/src/index.ts:302-428`:

```ts
export interface Hooks {
  event?:  (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?:   { [key: string]: ToolDefinition }

  auth?:     AuthHook
  provider?: ProviderHook

  "chat.message"?:   (input, output: { message: UserMessage; parts: Part[] }) => Promise<void>
  "chat.params"?:    (input, output: { temperature; topP; topK; maxOutputTokens; options }) => Promise<void>
  "chat.headers"?:   (input, output: { headers: Record<string, string> }) => Promise<void>

  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>

  "command.execute.before"?: (input: { command; sessionID; arguments }, output: { parts: Part[] }) => Promise<void>
  "tool.execute.before"?:    (input: { tool; sessionID; callID }, output: { args: any }) => Promise<void>
  "shell.env"?:              (input: { cwd; sessionID?; callID? }, output: { env: Record<string, string> }) => Promise<void>
  "tool.execute.after"?:     (input: { tool; sessionID; callID; args }, output: { title; output; metadata }) => Promise<void>

  "experimental.chat.messages.transform"?: (input, output: { messages: ... }) => Promise<void>
  "experimental.chat.system.transform"?:   (input, output: { system: string[] }) => Promise<void>
  "experimental.session.compacting"?:      (input, output: { context: string[]; prompt?: string }) => Promise<void>
  "experimental.compaction.autocontinue"?:  (input, output: { enabled: boolean }) => Promise<void>
  "experimental.text.complete"?:           (input, output: { text: string }) => Promise<void>

  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>

  "actor.preStop"?:  ActorPreStopRegistration
  "actor.postStop"?: ActorPostStopRegistration
}
```

### 6.2 Hook names (grouped)

| Category | Hook names |
| --- | --- |
| **Lifecycle** | `config`, `event` |
| **Tool surface** | `tool`, `tool.definition` |
| **Auth/Provider** | `auth`, `provider` |
| **Chat** | `chat.message`, `chat.params`, `chat.headers`, `permission.ask` |
| **Tool execution** | `command.execute.before`, `tool.execute.before`, `tool.execute.after`, `shell.env` |
| **Compaction** | `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.session.compacting`, `experimental.compaction.autocontinue` |
| **Text output** | `experimental.text.complete` |
| **Subagent delivery** | `actor.preStop`, `actor.postStop` |

### 6.3 Plugin registration

Plugins are loaded as ES modules from npm packages, local files, or
project `.mimocode/plugin(s)/` directories. The registry's `applyPlugin`
function (`packages/opencode/src/plugin/index.ts:167-200`) supports two
shapes:

- **V1 plugin**: module exports `server` (a function returning a `Hooks`
  object) and `detect`.
- **Legacy plugin**: module exports any number of named functions that take
  `(input, options)` and return a `Hooks` object.

Internal plugins registered directly in code (`plugin/index.ts:124-139`):

```ts
const INTERNAL_PLUGINS: PluginInstance[] = [
  MimoFreeAuthPlugin,
  MimoAuthPlugin,
  AnthropicProxyPlugin,
  CodexAuthPlugin,
  CopilotAuthPlugin,
  GitlabAuthPlugin as unknown as PluginInstance,
  PoeAuthPlugin as unknown as PluginInstance,
  CloudflareWorkersAuthPlugin,
  CloudflareAIGatewayAuthPlugin,
  CheckpointSplitoverPlugin,
  SubagentProgressCheckerPlugin,
]
```

### 6.4 Late-bound service reference

The `workflow` tool cannot take a hard `WorkflowRuntime.Service` Layer
dependency — that would force every layer that builds the registry
(the app runtime plus ~9 test harnesses) to provide it. The tool
instead reads through a module-local mutable reference. The rationale
is explained verbatim in `runtime-ref.ts:1-18`:

> The `workflow` tool needs to call WorkflowRuntime (start/status/wait/cancel).
> Wiring `WorkflowRuntime.Service` as a normal Layer dependency on the tool
> would force it into `ToolRegistry.layer`'s requirement set, which every
> layer that builds the registry (the app runtime plus ~9 test harnesses)
> would then have to satisfy — the same blast radius that motivated
> `spawnRef` for the Actor service. Instead, `WorkflowRuntime.layer`
> populates this module-local reference on initialisation, and the tool
> reads from it at call time. The requirement is broken at the type level
> because the tool no longer declares a `WorkflowRuntime.Service` dependency.

The same pattern is used by the `actor` tool (referencing
`@/actor/spawn-ref`) and the inbox service (referencing
`@/inbox/inbox-ref`, imported at `tool/actor.ts:19`). The runtime
populates `workflowRef.current` on layer init and clears it on finalizer
(`runtime.ts:1216-1221`).

### 6.5 Tool plugin shape

A plugin can contribute tools via the `tool` field. The registry converts
plugin tool definitions into runtime `Tool.Def` entries (`registry.ts:148-177`):

```ts
function fromPlugin(id: string, def: ToolDefinition): Tool.Def {
  return {
    id,
    parameters: z.object(def.args),
    description: def.description,
    execute: (args, toolCtx) =>
      Effect.gen(function* () {
        const pluginCtx: PluginToolContext = {
          ...toolCtx,
          ask: (req) => toolCtx.ask(req),
          directory: ctx.directory,
          worktree: ctx.worktree,
        }
        const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
        /* ... */
      }),
  }
}
```

---

## 7. Configuration & Persistence

### 7.1 Config file location

The README states (`README.md:101`):

> MiMoCode is configured via `.mimocode/mimocode.json` in the project directory
> (or `~/.config/mimocode/mimocode.json` globally).

The actual loader (`packages/opencode/src/config/config.ts:558-559`) merges
candidates in order:

```ts
mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.json")))
mergeDeep(yield* loadFile(path.join(Global.Path.config, "mimocode.jsonc")))
```

with project-local `.mimocode/mimocode.json` taking precedence (via
`ConfigPaths.files`, `config.ts:739`).

### 7.2 XDG paths

The four base directories (`data`, `cache`, `config`, `state`) are resolved
by `packages/shared/src/global.ts:26-50`:

```ts
export function resolveMimocodeHome(env: NodeJS.ProcessEnv = process.env): ResolvedPaths {
  const home = env.MIMOCODE_HOME
  if (home) {
    if (!path.isAbsolute(home)) {
      throw new Error(`MIMOCODE_HOME must be an absolute path, got: ${JSON.stringify(home)}`)
    }
    return {
      mode: "mimocode_home",
      root: home,
      data:   path.join(home, "data"),
      cache:  path.join(home, "cache"),
      config: path.join(home, "config"),
      state:  path.join(home, "state"),
    }
  }
  return {
    mode: "xdg",
    data:   path.join(xdgData!,   APP),
    cache:  path.join(xdgCache!,  APP),
    config: path.join(xdgConfig!, APP),
    state:  path.join(xdgState!,  APP),
  }
}
```

- `MIMOCODE_HOME` (env): all four dirs become subdirs.
- Otherwise: XDG Base Directory defaults (`xdgData` → `~/.local/share/mimocode`,
  etc.).

### 7.3 Schema sketch

The full config schema is in `packages/opencode/src/config/config.ts`
(1,024 lines). Highlights:

#### Workflow configuration (`config.ts:388-406`)

```ts
workflow: Schema.optional(Schema.Struct({
  maxConcurrentAgents: Schema.optional(Schema.Number).annotate({
    description: "Process-wide ceiling on subagents running concurrently across ALL workflow runs ... Default min(16, 2x CPU cores)."
  }),
  maxDepth: Schema.optional(Schema.Number).annotate({
    description: "Max nesting depth for workflow()-calls-workflow. Default 8."
  }),
  maxLifecycleAgents: Schema.optional(Schema.Number).annotate({
    description: "Hard ceiling on total agents a single workflow run may spawn over its life. Default 1000. ..."
  }),
  scriptDeadlineMs: Schema.optional(Schema.Number).annotate({
    description: "Wall-clock budget for a whole workflow script, in milliseconds. Default 12h. ..."
  }),
})).annotate({ description: "Dynamic workflow runtime settings." })
```

#### Memory (`config.ts:323-336`)

```ts
memory: Schema.optional(Schema.Struct({
  cc_index: Schema.optional(Schema.Boolean).annotate({
    description: "Index Claude Code memory (~/.claude/projects/<slug>/memory) and expose under scope='cc'. Default: false. ..."
  }),
}))

checkpoint: Schema.optional(Schema.Struct({
  memory_reconcile_on_search:  Schema.optional(Schema.Boolean),
  memory_search_score_floor:   Schema.optional(Schema.Number),  // default 0.15
  thresholds:                   /* ["40%", "60%", "80%"] */,
  reserve_tokens:               /* default 20000 */,
  writer_max_consecutive_failures: /* default 3 */,
  memory_titles:    /* default 500  */,
  global:           /* default 6000  */,
  checkpoint:       /* default 11000 */,
  memory:           /* default 10000 */,
  design_decisions: /* default 3000  */,
  open_notes:       /* default 800   */,
}))
```

#### Experimental (`config.ts:356-387`)

```ts
experimental: Schema.optional(Schema.Struct({
  disable_paste_summary: Schema.optional(Schema.Boolean),
  batch_tool:            Schema.optional(Schema.Boolean),
  openTelemetry:         Schema.optional(Schema.Boolean),
  primary_tools:         Schema.optional(...),
  continue_loop_on_deny: Schema.optional(Schema.Boolean),
  mcp_timeout:           Schema.optional(PositiveInt),
  predict_next_prompt:   Schema.optional(Schema.Boolean),
  maxMode:               Schema.optional(Schema.Struct({
    candidates: Schema.optional(PositiveInt),   // default 5
  })),
}))
```

#### Providers

Each provider has its own section in the config schema, dynamically
discovered by `ConfigMCP`, `ConfigProvider`, etc.

### 7.4 Database tables (Drizzle)

The migration history lives under `packages/opencode/migration/`. The
workflow-specific table is `workflow_run` (§2.8). Other tables include
`session`, `message`, `part`, `task`, `task_event`, `memory_fts`, etc.

The schema follows the project-wide convention documented in
`packages/opencode/AGENTS.md:1-10`:

> Drizzle schema lives in `src/**/*.sql.ts`. Naming: tables and columns use
> snake_case; join columns are `<entity>_id`; indexes are `<table>_<column>_idx`.

### 7.5 Environment flags

`packages/opencode/src/flag/flag.ts` (164 lines) exports `Flag`, a flat
constant bag read from `process.env`. The workflow tool is gated on
`Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL` (`flag.ts:118`):

```ts
MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL"),
```

The full set of MIMOCODE-prefixed flags spans 60+ entries (sample):
`MIMOCODE_AUTO_SHARE`, `MIMOCODE_DISABLE_AUTOUPDATE`,
`MIMOCODE_ENABLE_ANALYSIS`, `MIMOCODE_DISABLE_PRUNE`,
`MIMOCODE_DISABLE_FILEWATCHER`, `MIMOCODE_HOME`, `MIMOCODE_DISABLE_GIT`,
`MIMOCODE_MIMO_ONLY`, `MIMOCODE_EXPERIMENTAL_FILEWATCHER`,
`MIMOCODE_EXPERIMENTAL_LSP_TOOL`, `MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL`,
`MIMOCODE_MODELS_URL`, `MIMOCODE_DB`, `MIMOCODE_DISABLE_CHANNEL_DB`, …

### 7.6 Plugin and command discovery

The config loader also discovers:
- `.mimocode/plugins/*` and `.mimocode/plugin/*` directories
  (`config.ts:801`).
- `.mimocode/commands/*` (project-local slash commands).
- `~/.claude/commands/*` (Claude Code compatibility — load order: CC first,
  then `.mimocode` overrides on name collision, `config.ts:756-763`).
- `~/.claude/skills/*` (CC skills, unless
  `MIMOCODE_DISABLE_CLAUDE_CODE_SKILLS` is set).

### 7.7 Bundled skills ("Compose skills")

The repo ships a bundle of 15 skills at
`packages/opencode/src/skill/compose/.bundle/`:

| Skill | Purpose (from `SKILL.md` frontmatter) |
| --- | --- |
| `ask` | Asking the user — covers question tool + never-ask fallback |
| `brainstorm` | Pre-implementation: turn ideas into designs and specs |
| `debug` | Systematic debugging before proposing fixes |
| `execute` | Executing implementation plans in a separate session |
| `feedback` | Code-review feedback reception |
| `merge` | Finishing a development branch |
| `new-skill` | Writing skills |
| `parallel` | Dispatching parallel agents |
| `plan` | Writing plans |
| `report` | Final reports |
| `review` | Code review requests |
| `subagent` | Subagent-driven development |
| `tdd` | Test-driven development |
| `verify` | Verification before completion |
| `worktree` | Git worktrees |

All are marked `hidden: true` in frontmatter; they are surfaced only when the
user is in **compose mode** (one of the three primary agents listed in the
README).

### 7.8 The Compose primary agent

The README lists three primary agents (`README.md:46-52`):

| Agent | Description |
| --- | --- |
| `build` | Default. Full tool permissions for development |
| `plan`  | Read-only analysis mode |
| `compose` | Orchestration mode for specs-driven / skill-driven workflows |

Pressing `Tab` switches between them. `compose` is the one that unlocks the
skill bundle above.

### 7.9 Other persistent state

- `~/.opencode-staging/opencode-bundle-patch/` is a process directory
  referenced by the runtime (used as the proxy launcher for development —
  not user-facing state).
- DB path: `~/.local/share/opencode/opencode.db` (WAL mode); overridable via
  `MIMOCODE_DB`.
- Project-local workflows under `.mimocode/workflows/<name>.js`.

---

## 8. Concurrency & Determinism

### 8.1 The PRNG

The sandbox replaces `Math.random` with a **Mulberry32** seeded by the first
4 bytes of `sha1(runID)` interpreted as a big-endian uint32:

(`packages/opencode/src/workflow/runtime.ts:1035-1046`):

```ts
// Per-run PRNG seed = first 4 bytes of sha1(runID). runID is unique-per-run
// and persisted, so resume of the SAME run derives the SAME seed → guest
// Math.random replays identically (the replay invariant). Two UNRELATED runs
// of the same script get DIFFERENT runIDs → different seeds → different
// sequences, so sampling-style scripts get fresh coverage instead of
// repeating the same picks.
const seed = createHash("sha1").update(runID).digest().readUInt32BE(0)
const result = yield* Effect.tryPromise({
  try: () => evalScript(body, hooks, {
    deadlineMs: input.scriptDeadlineMs ?? SCRIPT_DEADLINE_MS,
    args: input.args,
    seed,
  }),
  catch: (e) => (e instanceof Error ? e : new Error(String(e))),
}).pipe(Effect.result)
```

The Mulberry32 itself is in `sandbox.ts:115-124`:

```js
let s = ${seed} >>> 0;
Math.random = function () {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
```

This is **the only** PRNG available to guest scripts; there is no second
stream.

### 8.2 Date deletion

`Date` is deleted, not stubbed (`sandbox.ts:113`):

```js
delete globalThis.Date;
```

A test confirms this (`sandbox.test.ts:113-135`):

```ts
test("Date is removed, Math.random is a seeded deterministic PRNG",
  async () => {
    const types = await evalScript(`return [typeof Date, typeof Math.random]`, {})
    expect(types).toEqual(["undefined", "function"])
    /* ... */
  })
```

The comment in `sandbox.ts:101-110` explains why:

> Date — deleted (nondeterministic wall-clock; scripts must not depend on it).
> Math.random — REPLACED with a SEEDED PRNG keyed on the run's seed […]

### 8.3 WeakRef / FinalizationRegistry deletion

Same rationale — they expose GC timing, which differs across runs:

```js
delete globalThis.WeakRef;
delete globalThis.FinalizationRegistry;
```

(`sandbox.ts:125-126`).

### 8.4 Counter invariants

Documented in detail in §2.13. The short version:

- `running++` happens **before** the spawn attempt.
- `running--` and exactly one of `succeeded++` or `failed++` happens
  **after** settle.
- Settle runs even when the spawn rejects (so a `spawn-reject` increments
  `failed`).
- Cache-hit replay (`journal.results.has(key)`) increments `succeeded`
  without spawning, and **does not** increment `agentCount` (which would
  burn the 1000 lifecycle cap on replays alone) (`runtime.ts:813-820`).

### 8.5 Lock primitive

`packages/opencode/src/util/lock.ts:1-96` is an in-process reader/writer lock
keyed by string, with writer-priority to prevent starvation:

```ts
export async function read(key: string): Promise<Disposable> { /* ... */ }
export async function write(key: string): Promise<Disposable> { /* ... */ }
```

Used for `resume()` of the same runID (`runtime.ts:1163`). The doc-comment
at `runtime.ts:1142-1157` is explicit about scope:

> LIMITATION: this is in-process only. Two SEPARATE processes resuming the
> same runID against the same DB (e.g. two server instances) are NOT covered
> […]

### 8.6 Process-wide semaphore

The single global semaphore is memoized at service scope and frozen for the
process lifetime (`runtime.ts:265-269`):

> Frozen for the process lifetime: a later config change to
> maxConcurrentAgents does NOT rebuild it (acceptable while workflow is
> experimental — the global ceiling is a process/config property).

A per-run semaphore is **always** clamped `≤ global` so a child can shrink
but never grow (`runtime.ts:451-452`).

### 8.7 Debounced counter flush

Counters are flushed to the DB at most once per 250 ms per run, with a
synchronous final flush on terminal (`runtime.ts:272-305`). This avoids
high-frequency DB writes during fan-out.

### 8.8 Adaptive microtask pump

The sandbox pump that drains QuickJS pending jobs uses an adaptive cadence
(`sandbox.ts:165-181`):

```ts
const FAST_MS    = 1
const SLOW_MS    = 50
const FAST_WINDOW = 50
let idleTicks = 0
const pumpOnce = () => {
  if (rt.hasPendingJob()) {
    rt.executePendingJobs()
    idleTicks = 0
  } else {
    idleTicks++
  }
  pumpTimer = setTimeout(pumpOnce, idleTicks < FAST_WINDOW ? FAST_MS : SLOW_MS)
}
```

A truly parked guest decays to ~50 ms polling; a busy guest stays at 1 ms.
The pump never stops, so it cannot deadlock (`sandbox.test.ts:64-93`
verifies that fast-tick count stays far below the parked duration).

### 8.9 Wall-clock deadline (reprise)

The host-side `Promise.race` against `vm.resolvePromise`
(`sandbox.ts:191-209`) is the **true** kill-switch for a parked guest —
the in-guest interrupt handler only fires while the guest is executing
bytecode (`sandbox.ts:184-189`):

> This timer is the true kill-switch for that case: it races resolvePromise
> and rejects when the budget elapses. The `finally` below still disposes the
> unsettled deferred before the context, so no process abort on cleanup.

---

## 9. Sandbox Security Model

### 9.1 Why quickjs-emscripten

The sandbox doc-comment at `sandbox.ts:66-77` justifies the choice of
`quickjs-emscripten` over alternatives:

> Hard constraints encapsulated here (validated by the 2026-06-01 spike):
> - sync-promise bridge (newPromise + executePendingJobs), NOT asyncify
> - a concurrent pump alongside resolvePromise so host-promises settle
> - every QuickJSHandle disposed before context dispose (else process abort)

The key wins, by elimination:

| Sandbox | Why not |
| --- | --- |
| `bun:vm` | Shares the host runtime — a malicious script could escape via `process` / `Bun` |
| `vm2` | CVE history; `process.mainModule.require('child_process').execSync(...)` escapes |
| `isolated-vm` | Native bindings, heavier; the chosen approach gets the same isolation through wasm |
| `quickjs-emscripten` (chosen) | Pure wasm sandbox; no shared heap with host; works on Bun without native deps |

The meta parser comment at `meta.ts:8-15` makes the same point with respect
to parsing:

> Why not `new Function`/`eval`: that runs the literal in the HOST realm,
> outside the QuickJS sandbox — a meta like
>   { name: (globalThis.process.mainModule.require('child_process').execSync('id'),'x') }
> would execute arbitrary host code.

### 9.2 Globals injected (guest)

| Global | Type | Source |
| --- | --- | --- |
| `agent(prompt, opts?)` | async host fn | `runtime.ts:798` |
| `phase(title)` | sync host fn | `runtime.ts:875` |
| `log(message)` | sync host fn | `runtime.ts:883` |
| `workflow(nameOrScript, args?, opts?)` | async host fn | `runtime.ts:897` |
| `readFile(rel)` | async host fn | `workspace.ts:32` |
| `writeFile(rel, content)` | async host fn | `workspace.ts:37` |
| `exists(rel)` | async host fn | `workspace.ts:41` |
| `glob(pattern)` | async host fn | `workspace.ts:45` |
| `args` | JSON value | `sandbox.ts:141-143` |
| `parallel(thunks)` | pure JS prelude | `sandbox.ts:41-42` |
| `pipeline(items, ...stages)` | pure JS prelude | `sandbox.ts:43-45` |
| `URL` | minimal polyfill | `sandbox.ts:50-63` |
| `Math` | with `Math.random` replaced | `sandbox.ts:115-124` |
| `JSON`, `Promise`, `Array`, … | bare quickjs-emscripten globals | — |

### 9.3 Globals stripped (guest)

Verified by `sandbox.test.ts:97-110`:

```ts
test("host globals are unreachable", async () => {
  const result = await evalScript(
    `return [typeof process, typeof Bun, typeof require, typeof globalThis.process]`,
    {},
  )
  expect(result).toEqual(["undefined", "undefined", "undefined", "undefined"])
})

test("constructor escape does not reach host process", async () => {
  const result = await evalScript(
    `try { return this.constructor.constructor("return typeof process")() } catch (e) { return "blocked" }`,
    {},
  )
  expect(result === "undefined" || result === "blocked").toBe(true)
})
```

The bare quickjs-emscripten runtime already lacks `crypto`, `performance`,
`fetch`, `setTimeout`/`setInterval`/`clearTimeout`, `process`, `Bun`,
`Temporal`, `gc`, `require`, and `globalThis.process`; they are absent
because the wasm engine doesn't ship them, not because the host actively
strips them (`sandbox.ts:97-100`):

> Determinism: the guest is a bare quickjs-emscripten JS engine — no Web/Node
> APIs exist (no crypto/performance/fetch/timers/process/Temporal/gc; all
> already undefined). We neutralize the JS built-ins whose output or timing
> is nondeterministic […]

### 9.4 Resource limits

| Limit | Default | Override |
| --- | --- | --- |
| Wall-clock per script | 12 h | `scriptDeadlineMs` (per run or per config) |
| Wall-clock per agent | off | `agentTimeoutMs` (per run) or `opts.timeoutMs` (per call) |
| Memory | 64 MiB | `SandboxOptions.memoryLimitBytes` |
| Total agents per run | 1000 | `maxLifecycleAgents` (per run or per config) |
| Concurrent in-flight agents | `min(16, 2 × cores)` | `maxConcurrentAgents` (per config) |
| Concurrent in-flight agents per run | inherits global | `maxConcurrentAgents` (per run, clamped ≤ global) |
| Workflow nesting depth | 8 | `maxDepth` (per run or per config) |

### 9.5 Known limitations

From `workspace.ts:11-19`:

> LIMITATION (by design, experimental): the check is NAME-based, not realpath —
> `Filesystem.contains` is purely lexical and does NOT resolve symlinks. A
> pre-existing symlink INSIDE the workspace that points OUTSIDE it (e.g. a
> pnpm store link under node_modules) is therefore NOT caught: a path through
> it resolves to an in-root lexical string, passes this check, and the
> underlying fs op follows the link out of the jail. Hardening to a true
> boundary means realpath-ing the resolved path (and, for writeFile, the
> leaf's parent) before the contains check — deferred until the feature
> graduates off the flag.

From `runtime.ts:1154-1157`:

> LIMITATION: this is in-process only. Two SEPARATE processes resuming the
> same runID against the same DB (e.g. two server instances) are NOT covered
> […]

Other notes:

- `glob()` returns workspace-relative paths only; matches outside the
  workspace are filtered, not errored (`workspace.ts:57-66`).
- The `URL` polyfill throws `TypeError("Invalid URL: …")` on inputs
  without a scheme+host, so scripts' `try/catch` fallbacks behave like
  the real URL (`sandbox.test.ts:238-244`).

---

## 10. Adoption Patterns

### 10.1 The `workflow` tool — recommended invocations

From the tool description (`tool/workflow.txt:1-25`):

```text
Execute a workflow script that orchestrates multiple subagents
deterministically. The script is plain JavaScript that runs in a sandbox
and fans out subagents via agent(), parallel(), and pipeline(). This tool
returns immediately with a run_id and runs in the background; the result
is delivered as a notification when the workflow completes.

operation "run": start a workflow. Provide either `name` (a built-in
workflow, see the catalog below) or `script` (inline JS; must begin with
`export const meta = { name, description }`). Returns a run_id immediately.
Optionally provide `workspace` (a dir the script's file primitives are
jailed to; defaults to the worktree).

operation "status": check a run's status by run_id.
operation "wait": block until a run completes (or times out), returning its result.
operation "cancel": cancel a running workflow by run_id (best-effort; in-flight
subagents stop at their next safe point, not instantly).
operation "resume": re-launch a persisted workflow by run_id under the same
run_id (re-runs its script; a convergent script does less work the second time).
```

Verbatim catalog renderer (`tool/registry.ts:67-83`):

```ts
export function renderWorkflowCatalog(): string {
  const list = BuiltinWorkflow.list()
  if (list.length === 0) return ""
  const entries = list.map((w) => {
    const phases = w.phases?.length ? "\n  Phases: " + w.phases.map((p) => p.title).join(" → ") : ""
    const when = w.whenToUse ? `\n  When to use: ${w.whenToUse}` : ""
    return `- ${w.name}: ${w.description}${when}${phases}`
  })
  return [
    "",
    "## Built-in workflows",
    'These named workflows are available via operation "run" with `name`. ...',
    "",
    ...entries,
    "",
    'Invoke a built-in: workflow({ operation: "run", name: "deep-research", args: "<the refined request>" })',
  ].join("\n")
}
```

### 10.2 Script-shape examples

#### Inline run with structured schema

```js
workflow({
  operation: "run",
  script: `
    export const meta = { name: "fanout", description: "Three parallel lookups" }
    const r = await parallel([
      () => agent("find X", { label: "x" }),
      () => agent("find Y", { label: "y" }),
      () => agent("find Z", { label: "z" }),
    ])
    return { results: r }
  `,
  args: { topic: "anything" },
})
```

#### Built-in invocation

```js
workflow({ operation: "run", name: "deep-research", args: "Compare Bun vs Node 22 for production HTTP servers" })
```

#### Status / wait / cancel / resume

```js
const { runID } = await workflow({ operation: "run", script: "..." })
const status = await workflow({ operation: "status", run_id: runID })
const done   = await workflow({ operation: "wait",   run_id: runID, timeout_ms: 600_000 })
await workflow({ operation: "cancel", run_id: runID })
const resumed = await workflow({ operation: "resume", run_id: runID })
```

### 10.3 Reference built-in (verbatim constants)

```js
// packages/opencode/src/workflow/builtin/deep-research.js:16-19
const JURY_SIZE      = 3
const REJECT_QUORUM  = 2
const SOURCE_BUDGET  = 15
const FACT_CAP       = 25
```

### 10.4 Composition patterns in scripts

From the workflow tests (`test/workflow/runtime.test.ts:34-42`):

```ts
const script = [
  `export const meta = { name: "t", description: "d" }`,
  `const r = await parallel([() => agent("a"), () => agent("b"), () => agent("c")])`,
  `return r`,
].join("\n")
```

From `deep-research.js:194-249`, the streaming search → read pattern:

```js
const perLine = await pipeline(
  plan.lines,
  line => agent(searchPrompt(line), {
    label: "search:" + line.topic, phase: "Search", schema: HITS_SHAPE
  }).then(r => /* ... */),
  found => /* de-dup + dispatch parallel reads */,
)
```

### 10.5 When to reach for workflows vs simpler tools

The README's framing (`README.md:46-52`) suggests workflows are for the
cases where one agent is insufficient:

- **Default `build` agent** — typical coding tasks. Tools (bash, read,
  edit, write, glob, grep) cover it.
- **`actor` tool** — when the LLM itself decides to delegate a single
  sub-task to a focused subagent.
- **`workflow` tool** — when the LLM wants a **deterministic,
  journaled, resumable, multi-agent script** that fans out N agents,
  possibly in parallel, possibly nested.
- **`task` tool** — for **tracking** the LLM's own progress (T1, T1.1,
  …) — orthogonal to delegation.

The `workflow.txt:23` summary is precise:

> Communicate between workflows by dataflow: return a value from a child
> and pass it as args to the next (or write a shared file via writeFile
> and read it in a later phase). Workflows do not message each other
> directly.

### 10.6 Compose-mode adoption

For spec-driven development, the README points users to **compose mode**
(`README.md:86`), which automatically loads the 15-skill bundle from §7.7.
These skills drive the LLM through a structured workflow: brainstorm → plan
→ tdd → execute → review → verify → merge → report.

---

## 11. Comparisons (Within MiMo's Own Framing)

The only explicit comparison MiMo-Code makes of itself is to its parent
project — `README.md:124-126`:

> MiMoCode is built as a fork of [OpenCode](https://github.com/anomalyco/opencode).
> It keeps all core OpenCode capabilities (multiple providers, TUI, LSP, MCP,
> plugins) and adds persistent memory, intelligent context management,
> subagent orchestration, goal-driven autonomous loops, compose workflows,
> and self-improvement via dream/distill.

(That link in the README currently points to the MiMo-Code repo itself;
the original OpenCode URL referenced in source comments is
`https://github.com/anomalyco/opencode`, also referenced in
`CONTRIBUTING.md:9`.)

The README's tagline ("Where Models and Agents Co-Evolve") and the project's
self-description ("terminal-native AI coding assistant") are the only
characterisations of MiMo-Code's niche.

The `README.zh.md:101` Chinese version offers the same framing.

No other explicit comparisons (to Claude Code, Codex CLI, or any peer
product) appear in the README, the public docs folder, or the bundled
skills.

---

## 12. References

### 12.1 Local source tree (path → file)

All citations in this document resolve against:

| Topic | File |
| --- | --- |
| Top-level README | `dependencies/MiMo-Code/README.md` |
| License | `dependencies/MiMo-Code/LICENSE` |
| Contributing | `dependencies/MiMo-Code/CONTRIBUTING.md` |
| Sandbox | `dependencies/MiMo-Code/packages/opencode/src/workflow/sandbox.ts` |
| Runtime | `dependencies/MiMo-Code/packages/opencode/src/workflow/runtime.ts` |
| Persistence | `dependencies/MiMo-Code/packages/opencode/src/workflow/persistence.ts` |
| DB schema | `dependencies/MiMo-Code/packages/opencode/src/workflow/workflow.sql.ts` |
| Events | `dependencies/MiMo-Code/packages/opencode/src/workflow/events.ts` |
| Meta parser | `dependencies/MiMo-Code/packages/opencode/src/workflow/meta.ts` |
| Built-in registry | `dependencies/MiMo-Code/packages/opencode/src/workflow/builtin.ts` |
| Built-in script | `dependencies/MiMo-Code/packages/opencode/src/workflow/builtin/deep-research.js` |
| Resolve | `dependencies/MiMo-Code/packages/opencode/src/workflow/resolve.ts` |
| Workspace | `dependencies/MiMo-Code/packages/opencode/src/workflow/workspace.ts` |
| Late-bound ref | `dependencies/MiMo-Code/packages/opencode/src/workflow/runtime-ref.ts` |
| Workflow tool | `dependencies/MiMo-Code/packages/opencode/src/tool/workflow.ts` |
| Workflow description | `dependencies/MiMo-Code/packages/opencode/src/tool/workflow.txt` |
| Actor tool | `dependencies/MiMo-Code/packages/opencode/src/tool/actor.ts` |
| Actor description | `dependencies/MiMo-Code/packages/opencode/src/tool/actor.txt` |
| Task tool | `dependencies/MiMo-Code/packages/opencode/src/tool/task.ts` |
| Memory tool | `dependencies/MiMo-Code/packages/opencode/src/tool/memory.ts` |
| Tool registry | `dependencies/MiMo-Code/packages/opencode/src/tool/registry.ts` |
| Tool core types | `dependencies/MiMo-Code/packages/opencode/src/tool/tool.ts` |
| Memory service | `dependencies/MiMo-Code/packages/opencode/src/memory/service.ts` |
| Memory FTS SQL | `dependencies/MiMo-Code/packages/opencode/src/memory/fts.sql.ts` |
| FTS query builder | `dependencies/MiMo-Code/packages/opencode/src/memory/fts-query.ts` |
| Memory paths | `dependencies/MiMo-Code/packages/opencode/src/memory/paths.ts` |
| Reconcile | `dependencies/MiMo-Code/packages/opencode/src/memory/reconcile.ts` |
| Memory path guard | `dependencies/MiMo-Code/packages/opencode/src/tool/memory-path-guard.ts` |
| Config schema | `dependencies/MiMo-Code/packages/opencode/src/config/config.ts` |
| Env flags | `dependencies/MiMo-Code/packages/opencode/src/flag/flag.ts` |
| Lock primitive | `dependencies/MiMo-Code/packages/opencode/src/util/lock.ts` |
| XDG resolver | `dependencies/MiMo-Code/packages/shared/src/global.ts` |
| File watcher | `dependencies/MiMo-Code/packages/opencode/src/file/watcher.ts` |
| Provider schema | `dependencies/MiMo-Code/packages/opencode/src/provider/schema.ts` |
| Task schema | `dependencies/MiMo-Code/packages/opencode/src/task/schema.ts` |
| Plugin core | `dependencies/MiMo-Code/packages/opencode/src/plugin/index.ts` |
| Plugin SDK | `dependencies/MiMo-Code/packages/plugin/src/index.ts` |
| Checkpoint paths | `dependencies/MiMo-Code/packages/opencode/src/session/checkpoint-paths.ts` |
| Checkpoint core | `dependencies/MiMo-Code/packages/opencode/src/session/checkpoint.ts` |
| Compose skills | `dependencies/MiMo-Code/packages/opencode/src/skill/compose/.bundle/*/SKILL.md` |
| Workflow tests | `dependencies/MiMo-Code/packages/opencode/test/workflow/{sandbox,runtime,persistence,builtin,meta,resolve,workspace,tool,runtime-nested,runtime-worktree,deep-research-cluster,model-routing,verify-wow}.test.ts` |

### 12.2 GitHub permalinks (resolved at the snapshot's HEAD)

The local clone is shallow (single-commit), so permalinks are against
`XiaomiMiMo/MiMo-Code@main`:

| Resource | URL |
| --- | --- |
| Repository | https://github.com/XiaomiMiMo/MiMo-Code |
| README | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/README.md |
| License | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/LICENSE |
| Contributing | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/CONTRIBUTING.md |
| Latest release (v0.1.1) | https://github.com/XiaomiMiMo/MiMo-Code/releases/tag/v0.1.1 |
| Contributors | https://github.com/XiaomiMiMo/MiMo-Code/graphs/contributors |
| Workflow runtime | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/workflow/runtime.ts |
| Built-in `deep-research.js` | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/workflow/builtin/deep-research.js |
| Workflow tool | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/opencode/src/tool/workflow.ts |
| Plugin SDK | https://github.com/XiaomiMiMo/MiMo-Code/blob/main/packages/plugin/src/index.ts |

The repo's GitHub description (verified via `https://api.github.com/repos/XiaomiMiMo/MiMo-Code`)
is **"MiMo Code: Where Models and Agents Co-Evolve"**.

### 12.3 License note

`LICENSE:1-22` is the standard MIT text:

```
MIT License

Copyright (c) 2026 MiMo Code, Xiaomi Corporation
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Two supplementary documents (`USE_RESTRICTIONS.md`, plus the external
[MiMo Terms of Service](https://platform.xiaomimimo.com/docs/terms/user-agreement))
apply to **use of the binary and hosted services**, not to the source
itself; the source code is plain MIT.

In addition, `USE_RESTRICTIONS.md` and `SECURITY.md` (linked from the
README) apply to **branding / use of the MiMo name and trademarks** for
the hosted service.

### 12.4 Where this document's facts could NOT be verified

The following items are **not** documented in the public MiMo-Code repo
as of the snapshot, and are flagged here so a future reader does not
mistake absence for error:

| Topic | Status |
| --- | --- |
| Long-form blog posts about MiMo-Code's internals | The README links to `https://mimo.xiaomi.com/en/blog/mimo-code-long-horizon` and `https://mimo.xiaomi.com/en/mimocode`. Both URLs returned HTTP 404 at the snapshot. |
| Tutorials / cookbooks beyond `deep-research.js` | None in the public repo. `docs/` contains only `build-release.md`. |
| A formal "adversarial jury" paper / blog | The constants (`JURY_SIZE=3`, `REJECT_QUORUM=2`, `SOURCE_BUDGET=15`, `FACT_CAP=25`) are documented only inside `deep-research.js` itself. |
| Provider list beyond the static schema | `provider/schema.ts` enumerates 11 well-known providers; the full list of dynamically-registered providers (e.g. via plugins) is not enumerated in one place. |
| Token caps for subagent memory | The `checkpoint.*` token caps in `config.ts:280-298` are documented; per-subagent caps are not. |
| Cross-process resume lock semantics | `runtime.ts:1154-1157` explicitly states cross-process resume is "out of scope for MR104 P2-1"; no further detail. |
| Plugin authoring guide | Not in `docs/`. The plugin SDK is in `packages/plugin/src/index.ts` and there is one example file `packages/plugin/src/example.ts`. |
| Build / release instructions | `docs/build-release.md` exists but is the only entry; full SST/deploy flow is in `sst.config.ts`. |
| Hot-reload of workflows | `workflow()` resolves scripts by file path on every call. `startWorkflowWatcher(workspace)` exposes `node:fs.watch` on each configured workflow subdirectory (`.sffmc/workflows/`, `.claude/workflows/`, walking up the tree); the watcher emits a `workflow:file-changed` event so consumers can invalidate caches or abort affected runs. Already-running runs continue with cached content until `resume()` notices a `script_sha` mismatch. |

These gaps are **not** claimed to be limitations of MiMo-Code; they are
simply items the public documentation does not currently cover.

---

*End of document.*
