# @sffmc/runtime

**Sandboxed JavaScript workflow orchestrator for OpenCode.** Spawns sub-tasks, fans out work in parallel, and pipelines multi-step jobs so you can run 200+ step workflows without losing context or getting stuck in loops.

## What it does

`@sffmc/runtime` registers a `workflow()` tool on OpenCode. Each call runs a named workflow (a self-contained JavaScript module) inside a quickjs-emscripten sandbox with deterministic I/O, no host filesystem access, and an interruptible tick budget. Workflows return a typed result that flows back to the main agent.

## Architecture

- `packages/runtime/src/sandbox.ts` — quickjs-emscripten host, interrupt signal marshaling
- `packages/runtime/src/concurrency.ts` — per-runtime `Concurrency` lock map; no module-level globals
- `packages/runtime/src/persistence.ts` — checkpoint / journal of every tool call the workflow makes; survives `Ctrl-C`
- `packages/runtime/src/builtin-registry.ts` — registers the bundled workflows under their `meta.name`
- `packages/runtime/src/flush-manager.ts` — debounced journal flush; CHECKPOINT threshold or explicit `flushNow()`
- `packages/runtime/src/counter-manager.ts` — `agentOpts` (concurrency caps, deadlines, token budgets)
- `packages/runtime/src/event-emitter.ts` — typed events surface for `mergeHooks` consumers

## Built-in workflows

- **`deep-research`** — Plan / Search / Extract / Group / Crosscheck / Report over a single question, with a 3-judge panel discarding weakly-sourced facts before drafting
- See `packages/runtime/builtin/` for the full registry

## Configure

```yaml
# ~/.config/sffmc/runtime.yaml
sandbox:
  max_wall_clock_ms: 28800000  # 8 hours, default
  interrupt_grace_ms: 5000
flush:
  threshold: 50                # buffered events before forced checkpoint
  deadline_ms: 60000           # hard floor: flush at least every 60 s
```

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    "npm:@sffmc/runtime@^0.15.1"
  ]
}
```

## License

[MIT](../../LICENSE)
</content>