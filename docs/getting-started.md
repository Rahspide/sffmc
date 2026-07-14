# Getting Started with SFFMC

Take a fresh OpenCode install from zero to "ran my first workflow and saved my own." About 2 minutes of reading plus 5 minutes of clicking.

## 1. What is SFFMC?

SFFMC ("Some Features From MiMo Code") is a monorepo of **5 MIT-licensed OpenCode packages** that port the productivity wins from Xiaomi's MiMo-Code fork into vanilla OpenCode 1.17.6+ — no fork required, drop them in and they install as plugins. **Two are composite packages**: `@sffmc/safety` (5 governance features: rules, watchdog, auto-max, eos-stripper, log-whitelist) and `@sffmc/memory` (FTS5 recall + opt-in checkpoint/judge/dream). **Two are standalones**: `@sffmc/runtime` (sandboxed JavaScript orchestrator — spawns sub-tasks, fans out work in parallel, pipelines multi-step tasks so you can run 200+ step jobs without losing context or stuck in loops) and `@sffmc/cognition` (parallel drafts with a judge + 18 drop-in structured-workflow skills). The fifth is the SDK `@sffmc/utilities` — a library other packages depend on, not a plugin entry itself.

## 2. Prerequisites

| Requirement | Minimum | Check |
|---|---|---|
| OpenCode | 1.17.6 or newer | `opencode --version` |
| Bun runtime | 1.0 or newer (for the plugin host) | `bun --version` |
| Disk | ~50 MB for the plugin set | — |
| Time | 2 minutes setup, 5 minutes to first run | — |

SFFMC is developed and tested on Linux (CachyOS / Arch-based, systemd). The plugins themselves are plain TypeScript and run anywhere Bun does.

## 3. Install

Add the SFFMC plugin paths to your `~/.config/opencode/opencode.json` under the `plugin` key. SFFMC is a monorepo of **5 packages** — **2 composites** (`@sffmc/safety`, `@sffmc/memory`) and **3 standalones** (`@sffmc/runtime`, `@sffmc/cognition`, `@sffmc/utilities`). Each composite bundles several sub-features (e.g. rules, watchdog, auto-max, eos-stripper, log-whitelist inside `@sffmc/safety`) into a single default export. Since v0.15.0 those sub-features ship as internal sub-modules of the parent composite and are no longer individually installable; pick the composite that owns the capability you want. `@sffmc/utilities` is a shared library used by the other packages and is not loaded as a plugin itself. The recommended way to install is via the `sffmc` CLI, which adds 4 installable plugins by default (2 composites + 2 most-used standalones):

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh

# Windows PowerShell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

Under the hood `install.sh` clones the repo to `~/.sffmc/plugins/sffmc` and runs `sffmc init`. To edit your plugin list manually, point each entry at a composite `src/index.ts` inside the monorepo:

```jsonc
{
  "plugin": [
    "file:///path/to/SFFMC/packages/safety/src/index.ts",
    "file:///path/to/SFFMC/packages/memory/src/index.ts",
    "file:///path/to/SFFMC/packages/runtime/src/index.ts",
    "file:///path/to/SFFMC/packages/cognition/src/index.ts"
  ]
}
```

Restart OpenCode after editing. The composites load in the order listed; that order is intentional and verified — see [codemap.md#hook-categories](../codemap.md#hook-categories) for the hook category dispatch and `bun run audit:load-order` to re-run the conflict check. Sub-features within a composite are internal sub-modules, not separate entry points; for finer-grained behaviour edit the composite's config rather than installing it piecewise.

To verify they loaded, open an OpenCode session and call any tool. If `@sffmc/runtime` is active, you'll see `workflow` in the tool list.

## 4. Your first workflow: deep-research

The fastest way to see the engine in action is `deep-research`, the canonical built-in. It runs six phases — Plan, Search, Extract, Group, Crosscheck, Report — and uses an adversarial jury of 3 voters to drop weakly-sourced facts before writing the report.

From any OpenCode chat:

```ts
workflow({
  operation: "run",
  name: "deep-research",
  args: { question: "What are the trade-offs between Bun and Node.js for a production HTTP server in 2026?" }
})
```

`run` returns immediately with a `run_id` and the current snapshot:

```json
{
  "run_id": "wf_8c3a91b2",
  "name": "deep-research",
  "status": "running",
  "currentPhase": "Search",
  "agentCount": 4,
  "succeeded": 3,
  "failed": 0,
  "tokensUsed": 12450
}
```

Poll for progress with `status`:

```ts
workflow({ operation: "status", run_id: "wf_8c3a91b2" })
```

Or block until it finishes (or times out):

```ts
workflow({ operation: "wait", run_id: "wf_8c3a91b2", timeout_ms: 600000 })
```

`wait` returns the full `WorkflowOutcome` — the `outcome.result` field carries the report, the `outcome.stats` field carries the jury's accept/reject counts. The `deep-research` builtin writes its summary, sections, and citation list into `outcome.result`.

The six phases execute in order inside a single sandboxed JavaScript runtime: **Plan** splits your question into 3–7 search lines, **Search** fans out one web-search agent per line in parallel, **Extract** deduplicates URLs and reads the top sources to pull checkable facts, **Group** folds facts that assert the same claim into a single entry so each is checked once, **Crosscheck** runs an adversarial jury of 3 voters per fact (2 rejects = fact dropped), and **Report** ranks survivors by certainty and writes the cited answer. Expect 10–30 minutes and 200k–500k tokens for a real question. Full API reference: [dynamic-workflow.md](dynamic-workflow.md).

## 5. Save a custom workflow

Built-ins are useful, but the real win is writing your own. Workflows are TypeScript files with a `meta` export (parsed without execution, used for the tool list and progress bar) and a `main` default export. Drop them in either of two locations:

| Location | Used by |
|---|---|
| `~/.sffmc/workflows/<name>.ts` | Project-shared or user-global workflows |
| `<project>/.claude/workflows/<name>.ts` | Legacy Claude Code compatibility |

A minimal workflow that does something useful:

```ts
// ~/.sffmc/workflows/rename-symbol.ts
export const meta = {
  name: "rename-symbol",
  description: "Rename a symbol across the project and verify the build still passes",
  whenToUse: "Use when renaming a function, type, or constant used in many files",
  phases: [
    { title: "Find",   detail: "Locate every call site" },
    { title: "Rename", detail: "Edit each file" },
    { title: "Verify", detail: "Run tests and lint" },
  ],
}

export default async function main(args) {
  phase("Find")
  const usages = await agent(
    `Find all uses of ${args.from} in ${args.path ?? "src/"}`,
    { tools: ["grep_app", "read"], schema: { type: "object", properties: { files: { type: "array", items: { type: "string" } }, count: { type: "number" } } } }
  )
  if (!usages) return { error: "find phase failed" }

  phase("Rename")
  const edits = await parallel(
    usages.files.map(f => () =>
      agent(`In ${f}, replace ${args.from} with ${args.to}. Use the edit tool.`, { tools: ["read", "edit"] })
    )
  )

  phase("Verify")
  const ok = await agent("Run tests and lint. Report any failures.", { tools: ["bash"] })

  return { filesFound: usages.count, filesChanged: edits.filter(Boolean).length, testsOk: ok !== null }
}
```

The `meta` block has four fields: `name` (required, unique), `description` (required, shown in the workflow picker), `whenToUse` (optional hint for picker), and `phases` (optional progress bar entries). Inside `main` you have three primitives: `agent(task, opts?)` runs one AI call and never throws (returns `null` on failure — always check), `parallel(thunks)` fans out thunks concurrently (throws on any failure), and `pipeline(items, ...stages)` streams items through sequential stages with parallel item processing. Side-channel helpers include `phase(title)`, `log(msg)`, `readFile`, `writeFile`, `glob`, `exists`, and `workflow(name, args)` to spawn a child workflow. Five more copy-pasteable examples: [workflow-examples.md](workflow-examples.md).

Run your saved workflow the same way as the built-in:

```ts
workflow({ operation: "run", name: "rename-symbol", args: { from: "oldName", to: "newName", path: "src/" } })
```

## 6. Debugging

Every run writes a JSONL journal, an SQLite row per step, and a copy of the script. To find them:

```bash
# Per-run journal (one JSON event per line — agent start/finish, phase changes, logs)
ls ~/.local/share/sffmc/workflow/*.jsonl

# Database (run metadata, step counts, costs)
sqlite3 ~/.local/share/sffmc/workflow/state.sqlite \
  "SELECT run_id, name, status, succeeded, failed, current_phase, tokens_used FROM workflow_runs ORDER BY started_at DESC LIMIT 10"
```

To find why a specific run failed, grep its journal for errors and the last few phase transitions:

```bash
RUN_ID="wf_8c3a91b2"
grep -E '"kind":"(agent_failed|error|phase)"' ~/.local/share/sffmc/workflow/${RUN_ID}.jsonl | tail -20
```

If the process died mid-run (status: `crashed`), every successful `agent()` call is already cached in the journal, so you can resume from the last checkpoint instead of redoing the work:

```ts
workflow({ operation: "resume", run_id: "wf_8c3a91b2" })
```

Resume replays cached agent results and continues from the next pending step. The script body is SHA-256 hashed on save — if you edit the script between runs, the journal is reset to avoid silently stale results. Five budget caps protect the engine: 1000 lifecycle agents, 200 steps per run, 16 concurrent agents, 1 hour wall-clock, 2 000 000 tokens. When a cap is hit, `agent()` returns `null` with `reason: "over-cap"` and your workflow should return a partial result.

## 7. Next steps

- **[README](../README.md)** — top-level overview, benchmark numbers, full feature list
- **[import-from-mimo.md](import-from-mimo.md)** — porting guide for users coming from Xiaomi's MiMo-Code
- **[load-order audit info in codemap.md](../codemap.md#hook-categories)** — hook category dispatch; re-run via `bun run audit:load-order`
- **[dynamic-workflow.md](dynamic-workflow.md)** — complete Workflow engine reference (budgets, sandbox internals, error model)
- **[workflow-examples.md](workflow-examples.md)** — five more ready-to-copy workflows (api-migration, security-audit, daily-report, hello-world, deep-research)

If a workflow is failing and the journal isn't enough to diagnose it, open an issue with the `run_id` and the last 20 lines of its journal — that's usually enough to reproduce.
