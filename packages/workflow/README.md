# @sffmc/workflow

> **Part of `@sffmc/agentic` composite.** This package is a sub-feature of the agentic bundle. Load via `@sffmc/agentic` for the full set (workflow + max-mode + compose + health), or standalone if you only need the workflow tool.



Dynamic Workflow — sandboxed JavaScript orchestrator (quickjs-emscripten).

## What it does

Lets an agent spawn long-running, multi-phase workflows written in a sandboxed JavaScript dialect. Workflows can call `agent()`, `parallel()`, and `pipeline()` primitives backed by the OpenCode SDK. Each run has a 5-layer budget (lifecycle 1000, concurrent 16, depth 8, wall-clock 12h, token 2M) and 3-layer state (SQLite row + per-run script + JSONL journal) that supports resume-after-crash via SHA-256 edit detection. The canonical example is `deep-research` (6 phases, adversarial jury, 200-step E2E-tested).

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/workflow/src/index.ts"
  ]
}
```

## Configuration

`@sffmc/workflow` takes no `~/.config/SFFMC/workflow.yaml`. Defaults are exported as `DEFAULT_WORKFLOW_CONFIG` from `src/types.ts` and `DEFAULT_SANDBOX_CONSTRAINTS` from `src/constants.ts` (extracted to break the original `types.ts` ↔ `runtime.ts` circular import) and applied at runtime startup.

## Hooks registered

| Hook | Purpose |
|---|---|
| `config` | Recover orphaned workflows from the previous session via `runtime.recoverOrphanedWorkflows()` |
| `tool` | Register the `workflow` tool: `run` / `status` / `wait` / `cancel` / `resume` operations |

The tool's operations:

```ts
workflow({
  op: "run",      // start a new workflow
  script: "...",  // inline JS or path
})
workflow({ op: "status", runID: "..." })
workflow({ op: "wait",   runID: "...", timeoutMs: ... })
workflow({ op: "cancel", runID: "..." })
workflow({ op: "resume", runID: "..." })
```

## Tests

```bash
bun test packages/workflow/
```

102 tests across 3 files:

- `tests/foundation.test.ts` — 73 type/persistence/resolve tests
- `tests/integration.test.ts` — 24 multi-step end-to-end
- `tests/e2e-200-steps.test.ts` — 5 long-horizon tests (200 sequential agents, lifecycle cap trip, token cap trip, parallel correctness, pipeline correctness)

## Builtins

`deep-research` — 6-phase research orchestrator (`JURY_SIZE=3`, `REJECT_QUORUM=2`, `SOURCE_BUDGET=15`, `FACT_CAP=25`). Ported from MiMo-Code. Loaded via `loadBuiltin("deep-research")`.

## License

MIT
