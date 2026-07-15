// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// `runSandboxed` orchestrator. v0.16.0-SOLID extension: the orchestrator
// no longer imports concrete helper modules directly EXCEPT for the
// determinism-hardening setup step (a single one-shot call with no
// substitution scenarios — making it a service would be overhead
// without a corresponding benefit). It accepts a `SandboxServices`
// container (see ./sandbox-services.ts) whose members implement
// narrow interfaces. The default container at the bottom of this
// file wires the real QuickJS-backed implementations. Tests can
// pass mock implementations to verify orchestration logic in
// isolation.
//
// SOLID mapping:
//   - S (Single Responsibility) — this file owns ONE thing: the
//     runSandboxed lifecycle. No business logic lives here.
//   - O (Open/Closed) — new behaviors (e.g. a new marshaling
//     strategy, a new pump cadence) are added by writing a new
//     implementation, not by editing this file.
//   - L (Liskov Substitution) — any `SandboxServices` container
//     works; the partial typing guarantees the contract is met.
//   - I (Interface Segregation) — each interface is narrow
//     (RuntimeFactory, EvalExecutor, PumpFactory, DeadlineFactory,
//     HostBridge, MarshalingService). The marshaling was split out
//     from HostBridge in the SOLID revision.
//   - D (Dependency Inversion) — this module depends on
//     `SandboxServices` (abstraction), not on the concrete helper
//     modules. The default container is a private detail of this
//     file.

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten"
import type { SandboxConstraints } from "./types.ts"
import { SCRIPT_DEADLINE_MS } from "./constants.ts"
import { buildHostHooks, PRELUDE } from "./sandbox-prelude.ts"
import { createLogger } from "@sffmc/utilities"

const log = createLogger("sandbox")
import { DEFAULT_PRNG_SEED } from "./sandbox-runtime.ts"
import { createSandboxRuntime } from "./sandbox-runtime.ts"
import { evalAndDiscard, evalAndReturn } from "./sandbox-eval.ts"
import { startMicrotaskPump, createDeadlineRace } from "./sandbox-pump.ts"
import { injectHooks, marshalIn } from "./sandbox-bridge.ts"
import type {
  DeadlineFactory,
  EvalExecutor,
  HostBridge,
  MarshalingService,
  MicrotaskPumpFactory,
  SandboxRuntimeFactory,
  SandboxServices,
} from "./sandbox-services.ts"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** An injected host function: receives already-marshaled JS args,
 *  returns a JS value or Promise. */
export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>

/** The full set of primitives available inside the sandbox. */
export interface SandboxPrimitives {
  agent: (task: string, opts?: Record<string, unknown>) => Promise<unknown>
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>
  pipeline: <T>(items: T[], ...stages: Array<(acc: unknown, item: T, i: number) => Promise<unknown>>) => Promise<Array<unknown>>
  workflow: (nameOrScript: string, args?: unknown) => Promise<unknown>
  phase: (title: string) => void
  log: (msg: string) => void
  readFile: (path: string) => Promise<string | null>
  writeFile: (path: string, content: string) => Promise<void>
  glob: (pattern: string) => Promise<string[]>
  exists: (path: string) => Promise<boolean>
  /** Host-injected: list the parent's available MCP tool names. */
  mcpList: () => Promise<string[]>
  /** Host-injected: dispatch a single MCP tool call. */
  mcpCall: (name: string, args: unknown) => Promise<unknown>
  args: unknown // injected by value
}

/** Options for the orchestrator. `services` is the DI container —
 *  tests pass a partial container with one mocked service, prod
 *  callers omit it and get the default container (real QuickJS). */
export interface RunSandboxedOptions
  extends Partial<SandboxConstraints> {
  seed?: number
  /** Dependency-injection container. Defaults to the real services
   *  in the private `defaultServices` constant below. Tests pass a
   *  partial container. */
  services?: Partial<SandboxServices>
}

/**
 * Run a workflow script body inside an isolated quickjs-emscripten context.
 *
 * Hard constraints:
 *  - sync-promise bridge (newPromise + executePendingJobs), NOT asyncify
 *  - a concurrent pump alongside resolvePromise so host-promises settle
 *  - every QuickJSHandle disposed before context dispose (else process abort)
 *  - NEVER THROWS — returns null on any error (per never-throw contract)
 */
export async function runSandboxed(
  source: string,
  primitives: SandboxPrimitives,
  opts?: RunSandboxedOptions,
): Promise<unknown> {
  // Resolve DI: caller-supplied services win, defaults fill the rest.
  // The full container is required — Partial<SandboxServices> in the
  // input type guarantees this at compile time, but the merge gives
  // runtime safety in case someone passes an empty object.
  // Common path: caller passes nothing, defaults are reused without
  // allocating a new container.
  const services = mergeServices(opts?.services)

  const QJS = await getQuickJS()
  const deadlineMs = opts?.deadlineMs ?? SCRIPT_DEADLINE_MS

  let rt: ReturnType<SandboxRuntimeFactory["create"]> | undefined
  let ctx: QuickJSContext | undefined
  const arena: QuickJSHandle[] = []
  // Deferreds for async hooks: tracked so an UNSETTLED one is still
  // disposed before context dispose (else process aborts).
  const deferreds: QuickJSDeferredPromise[] = []
  const track = <H extends QuickJSHandle>(h: H): H => {
    arena.push(h)
    return h
  }

  try {
    // --- Service call: runtime factory ---
    rt = services.runtime.create({
      QJS,
      seed: opts?.seed,
      memoryMB: opts?.memoryMB,
      stackSize: opts?.stackSize,
      deadlineMs,
    })
    ctx = rt.newContext()

    // --- Service call: host bridge (inject) ---
    const hooks = buildHostHooks(primitives)
    services.bridge.inject(ctx, hooks, track, deferreds)

    // --- Determinism hardening: a single one-shot setup step with no
    //     substitution scenarios. Making it a service would add
    //     indirection without a corresponding benefit. The function
    //     itself lives in `./sandbox-runtime.ts` (alongside the
    //     runtime factory it relates to). ---
    const seed = (opts?.seed ?? DEFAULT_PRNG_SEED) >>> 0
    evalAndDiscard(
      ctx,
      `
        delete globalThis.Date;
        (function () {
          let s = ${seed >>> 0};
          Math.random = function () {
            s = (s + 0x6d2b79f5) >>> 0;
            let t = s;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
          };
        })();
        delete globalThis.WeakRef;
        delete globalThis.FinalizationRegistry;
      `,
      "harden determinism",
    )

    // --- Service call: eval executor (discard, for PRELUDE) ---
    services.eval.discard(ctx, PRELUDE, "workflow prelude error")

    // --- Service call: marshaling (for args) ---
    const argsHandle = services.marshaller.marshalIn(ctx, primitives.args ?? null)
    ctx.setProp(ctx.global, "args", argsHandle)
    argsHandle.dispose()

    // --- Service call: eval executor (return, for user script) ---
    const wrapped = `(async () => {\n${source}\n})()`
    const promiseHandle = track(
      services.eval.return(ctx, wrapped, "workflow script error"),
    )

    // --- Service call: microtask pump (start) ---
    const pump = services.pump.start(rt)

    // --- Service call: deadline factory (create) ---
    const { promise: deadline, timer: deadlineTimer } =
      services.deadline.create(deadlineMs)

    try {
      const resolved = await Promise.race([
        ctx.resolvePromise(promiseHandle).then(
          (r) => ({ kind: "resolved" as const, r }),
          (e) => ({ kind: "rejected" as const, e }),
        ),
        deadline.then(
          () => ({ kind: "deadline" as const }),
          (e) => ({ kind: "deadline" as const, err: e }),
        ),
      ])
      if (resolved.kind === "deadline") return null
      if (resolved.kind === "rejected") return null
      // Discriminated union narrows to { kind: "resolved"; r } here,
      // so no type assertion needed.
      const r = resolved.r
      if (r.error) {
        const err = ctx.dump(r.error)
        r.error.dispose()
        return null
      }
      const valueHandle = track(r.value)
      return ctx.dump(valueHandle)
    } finally {
      pump.stop()
      clearTimeout(deadlineTimer)
    }
  } catch (e) {
    // Never-throw contract: catch all errors, return null.
    log.warn({ err: e }, "sandbox: runSandboxed caught top-level error (returning null per contract)")
    return null
  } finally {
    // Dispose deferreds BEFORE the arena/context: an unsettled
    // deferred still owns live guest handles, and ctx.dispose()
    // aborts the process if any GC object is still alive.
    for (const d of deferreds) {
      if (d.alive) d.dispose()
    }
    for (const h of arena) {
      if (h.alive) h.dispose()
    }
    if (ctx) ctx.dispose()
    if (rt) rt.dispose()
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Default services — real QuickJS-backed implementations. Built
 *  once at module load. Kept private to this file (not exported) so
 *  the only public surface is `runSandboxed` (the orchestrator)
 *  and the `RunSandboxedOptions.services` field (the DI seam). */
const defaultServices: SandboxServices = {
  runtime: { create: (opts) => createSandboxRuntime(opts) },
  eval: {
    discard: (ctx, code, label) => evalAndDiscard(ctx, code, label),
    return: (ctx, code, label) => evalAndReturn(ctx, code, label),
  },
  pump: { start: (rt) => startMicrotaskPump(rt) },
  deadline: { create: (ms) => createDeadlineRace(ms) },
  bridge: { inject: (ctx, hooks, track, deferreds) => injectHooks(ctx, hooks, track, deferreds) },
  marshaller: { marshalIn: (ctx, value) => marshalIn(ctx, value) },
}

/** Merge a partial service container (caller-supplied) with the
 *  default container. Caller-supplied fields win, defaults fill
 *  the rest. The single place to maintain the merge logic. */
function mergeServices(
  partial: Partial<SandboxServices> | undefined,
): SandboxServices {
  if (!partial) return defaultServices
  return {
    runtime: partial.runtime ?? defaultServices.runtime,
    eval: partial.eval ?? defaultServices.eval,
    pump: partial.pump ?? defaultServices.pump,
    deadline: partial.deadline ?? defaultServices.deadline,
    bridge: partial.bridge ?? defaultServices.bridge,
    marshaller: partial.marshaller ?? defaultServices.marshaller,
  }
}

// ---------------------------------------------------------------------------
// Re-exports for callers that want to build their own service container
// (e.g. tests, alternate runtimes).
// ---------------------------------------------------------------------------

export type {
  SandboxRuntimeFactory,
  EvalExecutor,
  MicrotaskPumpFactory,
  DeadlineFactory,
  HostBridge,
  MarshalingService,
  SandboxServices,
} from "./sandbox-services.ts"
