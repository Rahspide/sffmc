# @sffmc/runtime

**Sandboxed JavaScript workflow orchestrator for OpenCode.** Spawns sub-tasks, fans out work in parallel, and pipelines multi-step jobs so you can run 200+ step workflows without losing context or getting stuck in loops.

## What it does

`@sffmc/runtime` registers a `workflow()` tool on OpenCode. Each call runs a named workflow (a self-contained JavaScript module) inside a quickjs-emscripten sandbox with deterministic I/O, no host filesystem access, and an interruptible tick budget. Workflows return a typed result that flows back to the main agent.

## Architecture

v0.16.0 split the original god-classes into focused modules. The
orchestrator files (left) wire the helper modules (right) together:

- `packages/runtime/src/runtime.ts` — main `WorkflowRuntime` class. Lifecycle, public API (start/status/wait/cancel/resume), composes the 11 sub-components via the SOLID `Services` + `Callbacks` DI container.
- `packages/runtime/src/sandbox.ts` — `runSandboxed` orchestrator (~220 LOC). Wires 6 sandbox services (runtime, eval, pump, deadline, bridge, marshaller) per the SOLID DI container in `sandbox-services.ts`.
- `packages/runtime/src/persistence.ts` — barrel re-exporting 10 modules (runid, script-sha, journal-key, paths, runs, steps, fsync-coalescer, journal, scripts, workflow-persistence).
- `packages/runtime/src/concurrency.ts` — per-runtime `Concurrency` lock map; no module-level globals.
- `packages/runtime/src/flush-manager.ts` — debounced journal flush; CHECKPOINT threshold or explicit `flushNow()`.
- `packages/runtime/src/counter-manager.ts` — `agentOpts` (concurrency caps, deadlines, token budgets).
- `packages/runtime/src/event-emitter.ts` — typed events surface for `mergeHooks` consumers.

### Sandbox helpers (5 modules, behind `SandboxServices` interfaces)

- `sandbox-prelude.ts` — PRELUDE globals (`parallel`, `pipeline`, `mcp.list/call`) + `buildHostHooks`.
- `sandbox-runtime.ts` — `createSandboxRuntime` (memory, stack, deadline interrupt) + `hardenDeterminism` (mulberry32 PRNG, Date/WeakRef strip).
- `sandbox-eval.ts` — `evalAndDiscard` / `evalAndReturn` with labeled error disposal.
- `sandbox-pump.ts` — `startMicrotaskPump` (adaptive cadence) + `createDeadlineRace` (wall-clock reject).
- `sandbox-bridge.ts` — `injectHooks` + `marshalIn` for the host↔guest boundary.
- `sandbox-services.ts` — narrow interfaces (`SandboxRuntimeFactory`, `EvalExecutor`, `MicrotaskPumpFactory`, `DeadlineFactory`, `HostBridge`, `MarshalingService`).

### Runtime sub-components (4 modules, behind `RuntimeServices` interfaces)

- `run-completer.ts` — completeRun / failRun / settleEntry. Implements `IRunCompleter`.
- `mcp-dispatcher.ts` — list / call. Implements `IMcpDispatcher`.
- `agent-primitive.ts` — spawnAgent / executeAgentCall / runParallel / runPipeline / publishAgentFailed. Implements `IAgentPrimitive`.
- `child-workflow-primitive.ts` — spawn / setPhase / appendLog / start. Implements `IChildWorkflowPrimitive`.
- `runtime-services.ts` — `RuntimeServices` (11 sub-component deps) + `RuntimeCallbacks` (9 method-bridge callbacks).

### Built-in workflows

- **`deep-research`** — Plan / Search / Extract / Group / Crosscheck / Report over a single question, with a 3-judge panel discarding weakly-sourced facts before drafting.
- See `packages/runtime/src/builtin/` for the full registry (7 builtins: `deep-research`, `plan`, `tdd`, `refactor`, `security-audit`, `doc-gen`, `lib-migrate`).

## Configure

```yaml
# ~/.config/sffmc/runtime.yaml
sandbox:
  max_wall_clock_ms: 3600000   # 1 hour, default
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
    "npm:@sffmc/runtime@^0.15.4"
  ]
}
```

## License

[MIT](../../LICENSE)
</content>