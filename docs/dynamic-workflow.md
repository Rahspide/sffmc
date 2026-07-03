# Dynamic Workflow Engine

**Shipped**: 2026-06-14 · **Version**: v0.6.0 (historical — see CHANGELOG) · **Package**: `@sffmc/runtime` · **LOC**: ~1500

## What it is

Sandboxed JavaScript execution for orchestrating long-running, multi-step
LLM tasks — 200+ steps, with budget caps, crash recovery, and a journal
that replays completed work after restart.

Three primitives inside the sandbox:
- `agent(task, opts?)` — launch one LLM agent and wait for a response
- `parallel(thunks)` — launch N agents in parallel
- `pipeline(items, ...stages)` — sequential chain of stages for
  each item

Example: a 6-phase research workflow (Plan → Search → Extract →
Group → Crosscheck → Report) runs with a single command:

```bash
workflow run --name deep-research --args.question "What is the best Rust web framework for 2026?"
```

Under the hood: ~30 agents (planner + searchers + readers + jury +
report author), each isolated, each with a deadline, the result
survives even a process crash.

## Why we built it

In a single session for a 200+ step task, the context window bloats,
attention decays, the model starts hallucinating or looping.
The "one session = one task" approach works up to ~30 steps, then —
degradation.

The workflow engine solves this differently:
- Each step (agent) is an isolated LLM call with no history accumulation
- State lives outside the context window — in SQLite + JSONL journal
- On process crash, workflow resumes from the last checkpoint
- Hard caps prevent budget runaway (1000 lifecycle agents,
  2M tokens, 16 concurrent, 1 hour wall-clock)

Result: one workflow replaces 5-10 manual sessions and costs the same
tokens those sessions would cost individually (often less,
since there are no duplicate queries).

## Quick start

```ts
// .sffmc/workflows/my-task.ts
export const meta = {
  name: "my-task",
  description: "Does something useful",
  whenToUse: "Use when you need to …",
  phases: [{ title: "Setup" }, { title: "Run" }, { title: "Cleanup" }],
}

export default async function main(args) {
  const plan = await agent("Plan: " + args.goal)
  const results = await parallel(
    plan.items.map(item => () => agent("Process: " + item))
  )
  return { plan, results }
}
```

Launch:

```bash
# In any OpenCode chat:
workflow({ operation: "run", name: "my-task", args: { goal: "migrate to Bun" } })
```

## The 3 primitives

### `agent(task, opts?)`

```ts
agent(task: string, opts?: {
  model?: string          // override model (e.g. "your-model-id")
  tools?: string[]        // which tools are available (default: all)
  schema?: object         // JSON Schema for structured output
  label?: string          // human-readable label for logs
  phase?: string          // which phase this belongs to (for journal)
  timeoutMs?: number      // per-agent deadline (default: 120s)
}): Promise<AgentResult>  // null | string | object
```

**Contract**: `agent()` **never throws an exception**. If something
goes wrong — it returns `null`. 5 reasons why:

| Reason | When | What to do in workflow |
|---|---|---|
| `over-cap` | Steps/tokens/time exceeded limit | Return intermediate result |
| `spawn-reject` | LLM call threw exception | Retry with fallback prompt |
| `timeout` | Agent didn't respond within `timeoutMs` | Increase timeout or simplify task |
| `actor-error` | Agent returned response without structure | Check schema in opts |
| `no-deliverable` | Response exists but structured/finalText empty | Check prompt |

**Structured output example**:

```ts
const SCHEMA = {
  type: "object", required: ["items"],
  properties: { items: { type: "array", items: { type: "string" } } }
}

const result = await agent("List all .ts files in src/", {
  tools: ["bash"],
  schema: SCHEMA,
  label: "file-lister",
})
// result = { items: ["src/index.ts", "src/runtime.ts", ...] }
// or null if agent failed
```

### `parallel(thunks)`

```ts
parallel(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
```

Launches all thunk functions simultaneously. Each function returns a
Promise — they execute concurrently (up to 16 at once, governed by a
global semaphore). The result is an array of the same length.

A thunk that throws crashes the ENTIRE parallel (unlike agent(), which
never-throws). If you need isolation — wrap:

```ts
const results = await parallel(
  items.map(item => () =>
    agent("process: " + item)  // never-throw — safe
  )
)
// results[i] = result or null
```

### `pipeline(items, ...stages)`

```ts
pipeline<T>(
  items: T[],
  ...stages: Array<(acc: unknown, item: T, index: number) => Promise<unknown>>
): Promise<Array<unknown>>
```

Each item passes through ALL stages sequentially, and items are
processed in parallel. Each stage receives: the previous stage's result,
the original item, the index.

```ts
const perLine = await pipeline(
  ["rust", "bun", "zig"],
  // Stage 1: search
  (topic) => agent("search: " + topic, { schema: HITS_SHAPE }),
  // Stage 2: read top hit
  (found) => agent("read: " + found.hits[0].url, { schema: READ_SHAPE }),
)
// perLine[i] = result of the second stage for each item
```

## Workflow files

### Where to store

- `packages/workflow/builtin/` — built-in (deep-research)
- `.sffmc/workflows/*.ts` — project-level
- `.claude/workflows/*.ts` — legacy (Claude Code compatibility)

### Structure

```ts
// Required meta-block (parsed without executing code)
export const meta = {
  name: "unique-name",           // required, non-empty
  description: "What it does",   // required, non-empty
  whenToUse: "When to pick it",  // optional, LLM hint
  phases: [                      // optional, for progress bar
    { title: "Step 1", detail: "What happens in step 1" },
    { title: "Stage 2", detail: "What happens in stage 2" },
  ],
  model: "your-model-id",      // optional, default model
}

// Main function (called automatically)
export default async function main(args) {
  // args — what was passed to workflow({ operation: "run", args: {...} })

  phase("Setup")        // mark phase start
  log("Starting...")    // write to journal

  const result = await agent("Do the thing")

  return result         // return result (goes into outcome.result)
}
```

Or without `main()` — top-level code also runs:

```ts
export const meta = { name: "inline", ... }

phase("One shot")
const answer = await agent("What is 2+2?")
// answer goes into result
```

## Side-channel primitives

Beyond `agent`/`parallel`/`pipeline`, the following are available inside workflow:

| Primitive | Signature | What it does |
|---|---|---|
| `phase(title)` | `(title: string) => void` | Sets the current phase (reflected in `workflow status`) |
| `log(msg)` | `(msg: string) => void` | Writes to the JSONL journal (visible in `workflow status`) |
| `args` | `unknown` | Arguments passed at launch |
| `readFile(path)` | `(path: string) => Promise<string \| null>` | Reads a file inside the jailed workspace |
| `writeFile(path, content)` | `(path: string, content: string) => Promise<void>` | Writes a file |
| `glob(pattern)` | `(pattern: string) => Promise<string[]>` | Globs inside workspace |
| `exists(path)` | `(path: string) => Promise<boolean>` | Checks existence |
| `workflow(name, args?)` | `(name: string, args?: unknown) => Promise<unknown>` | Launches a child workflow |

**Jail**: all filesystem operations are jailed inside the workspace (directory
passed at launch). `readFile("/etc/passwd")` returns `null`.

## Error handling

The key rule: `agent()` **never throws**. This means:

```ts
// CORRECT — check for null
const res = await agent("risky task")
if (res === null) {
  log("agent failed, trying fallback")
  return await agent("simpler task")
}

// INCORRECT — assume res is always an object
const items = res.items  // TypeError if res === null
```

`parallel()` and `pipeline()` — conversely, do throw. If a thunk throws
an exception — the whole batch crashes. An exception from the sandbox =
`failed` status for the entire run.

**Detect the failure reason** via the runtime's event bus:

```ts
import { createEventBus, WorkflowRuntime } from "@sffmc/runtime"

const runtime = new WorkflowRuntime(ctx)
runtime.events.on("workflow:agent_failed", (e) => {
  console.log(`Agent ${e.agentKey} failed: ${e.reason}`)
})
```

When using the workflow tool via `createWorkflowTool(runtime)`, observability listeners on the runtime's event bus are auto-wired — no manual `on()` call needed in typical setups.

## Budgets

5 cap levels, all configurable:

| Cap | Default | Override |
|---|---|---|
| **Lifecycle agents** | 1000 | `config.maxLifecycleAgents` |
| **Steps per run** | 200 | `config.maxSteps` |
| **Concurrent agents** | 16 | Global semaphore (auto = 2×CPU) |
| **Wall-clock** | 1 hour | `config.maxWallClockMs` |
| **Tokens** | 2 000 000 | `config.maxTokens` |

When any cap is reached — agent() starts returning `null` (reason:
`over-cap`). The workflow script must decide what to do — return an
intermediate result or fail with an error.

## Resume

Workflow automatically recovers after a process crash:

1. At OpenCode startup, `recoverOrphanedWorkflows()` is called — all runs
   with status `running` transition to `crashed`
2. The command `workflow({ operation: "resume", run_id: "wf_..." })` —
   resumes the workflow from the last checkpoint
3. SHA-256 of the script body is compared with the stored hash — if the
   script changed, the journal is reset (edit detection)
4. Every successful agent() is written to the JSONL journal — on replay
   the result is pulled from cache, the agent is not re-invoked

## MCP integration

Workflow does NOT have direct access to MCP servers. Instead,
use `agent()` with `tools` specified:

```ts
// Search via your LLM-backed search tool (works inside agent)
const hits = await agent("search: Rust web frameworks", {
  tools: ["bash"],  // agent can call bash, and bash — curl to your search endpoint
})

// Or directly via external tool if registered
const page = await agent("fetch: " + url, {
  tools: ["webfetch"],
})
```

Direct MCP bindings via `mcp.list()` and `mcp.call(name, args)` are
available since v0.14.0 (see `packages/runtime/src/mcp.ts`).

## Sandbox isolation

Workflow scripts execute inside a **quickjs-emscripten** WASM sandbox:

- **No access** to Node.js API, filesystem, network, process.env
- **No Date** (replaced to avoid non-determinism on replay)
- **Math.random** replaced with seeded PRNG (mulberry32) — replay
  is reproducible
- **URL** — minimal implementation for parsing (protocol, hostname,
  pathname)
- **Memory limit**: 64 MB
- **Instruction limit**: 5 000 000 (interrupts infinite loops)
- **Wall-clock deadline**: 1 hour per script

An attempt to `require("fs")`, `process.exit()`, or `fetch()` will throw
ReferenceError.

## Examples

### Hello world

```ts
export const meta = { name: "hello", description: "Hello world workflow", whenToUse: "demo", phases: [] }

export default async function main() {
  log("Hello from sandbox!")
  const answer = await agent("What is 1+1? Reply with just the number.")
  return { answer }
}
```

### API migration

```ts
export const meta = {
  name: "api-migration",
  description: "Migrate API calls from v1 to v2",
  phases: [{ title: "Find" }, { title: "Replace" }, { title: "Verify" }],
}

export default async function main(args) {
  phase("Find")
  const usages = await agent(`Find all ${args.oldAPI} calls in src/`, { tools: ["grep_app"] })

  phase("Replace")
  const changes = await parallel(
    usages.files.map(f => () =>
      agent(`Replace ${args.oldAPI} with ${args.newAPI} in ${f}`, { tools: ["edit"] })
    )
  )

  phase("Verify")
  const ok = await agent("Run tests and lint", { tools: ["bash"] })
  return { usages: usages.count, changed: changes.filter(Boolean).length, verified: ok !== null }
}
```

### Security audit

```ts
const files = await glob("**/*.ts")
const findings = await parallel(
  files.map(f => () => agent(`Audit ${f} for: sql injection, xss, hardcoded secrets, unsafe eval`, {
    tools: ["read"],
    schema: { type: "object", properties: { issues: { type: "array" } } },
  }))
)
return { files: files.length, issues: findings.flatMap(f => f?.issues ?? []) }
```

### Daily report

```ts
const logs = await glob("logs/*.log")
const summaries = await parallel(
  logs.map(f => () => agent(`Summarize ${f}: count errors, warnings, unique messages`, {
    tools: ["read"],
  }))
)
await writeFile("report.md", summaries.map((s, i) => `## ${logs[i]}\n${s}`).join("\n"))
return { files: logs.length, report: "report.md" }
```

### Deep research

The largest built-in workflow — 6 phases, adversarial jury:

```ts
workflow({ operation: "run", name: "deep-research", args: { question: "What is the best Rust web framework for 2026?" } })
```

[More in code →](../packages/workflow/builtin/deep-research.ts)

## Comparison to MiMo-Code

| Aspect | MiMo-Code | SFFMC Workflow |
|---|---|---|
| **Sandbox** | `vm.createContext` (Node-only) | quickjs-emscripten WASM (Bun/Node/browser) |
| **Primitives** | agent, parallel, pipeline | agent, parallel, pipeline (same signatures) |
| **State** | 3-layer (SQLite + script + JSONL) | Same + WAL extension |
| **Budgets** | 2 caps (lifecycle, concurrent) | 5 caps (added: depth, token, wall-clock) |
| **LLM interface** | 5 tool operations | Same 5 (run/status/wait/cancel/resume) |
| **Deep research** | 391 lines JS, JURY_SIZE=3 | Ported to TS, 280 lines, same parameters |
| **MCP** | Direct bindings | No — via agent({ tools }) |
| **Streaming** | Yes (SSE via event) | No |

What we changed and why:
- **Added token cap (2M)** — MiMo didn't count tokens, could burn budget
- **Added depth cap (8)** — prevents recursive explosions
- **Replaced vm with QuickJS** — sandbox works in Bun (MiMo was Node-only)
- **Removed model: "lite"** — use the default model configured for your
  provider
- **Added seeded PRNG** — replay is now fully deterministic

## Known limitations

1. **Cross-process resume** — works only within a single process.
   After restarting OpenCode, `resume` must be called explicitly. No
   automatic resume.
2. **No direct MCP** — agent() cannot directly call MCP servers.
   Only via `tools: ["bash"]` and curl to your search endpoint.
3. **No streaming** — workflow result is only visible after completion.
   Cannot observe progress in real time.
4. **QuickJS performance** — JSON marshalling between host and guest costs
   ~0.5-2ms per call. For 200 steps that's ~100-400ms — negligible. For 2000
   steps — ~1-4s of overhead.
5. **Sandbox is single-threaded** — parallel() inside QuickJS uses
   microtasks (Promise.all), not real threads. Concurrency
   is achieved on the host side.
6. **Maximum 1000 lifecycle agents** — hard limit per runtime
   instance. When exceeded, agent() silently returns null.

## Future work

Planned improvements to the workflow engine include streaming progress events, cross-process resume coordination, MCP bindings for direct tool access from inside workflows, a web UI dashboard for monitoring running workflows, integration with the upstream scheduler so workflows can run as delegated tasks, and pre-built workflow templates for common patterns like code review and release checklists. Dates for these improvements are not yet committed.
