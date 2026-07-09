// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// runSandboxed orchestrator (slimmed). v0.16.0 refactor (ora-11, File 8):
// the 17 internal helpers that composed this file have been extracted
// to 5 focused modules (sandbox-prelude, sandbox-runtime, sandbox-eval,
// sandbox-pump, sandbox-bridge). The orchestrator wires them together.

import {
  getQuickJS,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from "quickjs-emscripten"
import type { SandboxConstraints } from "./types.ts"
import { SCRIPT_DEADLINE_MS } from "./constants.ts"
import { buildHostHooks, PRELUDE } from "./sandbox-prelude.ts"
import {
  createSandboxRuntime,
  hardenDeterminism,
  DEFAULT_PRNG_SEED,
} from "./sandbox-runtime.ts"
import { evalAndDiscard, evalAndReturn } from "./sandbox-eval.ts"
import { startMicrotaskPump, createDeadlineRace } from "./sandbox-pump.ts"
import {
  injectHooks,
  marshalIn,
  type HostFn,
} from "./sandbox-bridge.ts"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** An injected host function: receives already-marshaled JS args,
 *  returns a JS value or Promise. */
type HostFn = (...args: unknown[]) => unknown | Promise<unknown>

/** The full set of primitives available inside the sandbox.
 *  `parallel` / `pipeline` are defined in the PRELUDE (guest-side JS) and
 *  do NOT go through the host bridge — they are present in the interface so
 *  callers can provide typed stubs for type-safety even though the guest
 *  never calls the host versions. `args` is injected by value (JSON).
 *  `mcpList` / `mcpCall` are host-injected (one round-trip each) and the
 *  PRELUDE binds them into the single `mcp` object the guest sees. */
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
  /** Host-injected: list the parent's available MCP tool names. No-op
   *  (`Promise.resolve([])`) when MCP is not wired. */
  mcpList: () => Promise<string[]>
  /** Host-injected: dispatch a single MCP tool call. Rejects when the
   *  budget is exceeded, recursion depth limit is reached, or the parent
   *  SDK has no MCP surface. */
  mcpCall: (name: string, args: unknown) => Promise<unknown>
  args: unknown // injected by value
}

/**
 * Run a workflow script body inside an isolated quickjs-emscripten context.
 * Pure Promise boundary — knows nothing of Effect or actors. `primitives` are
 * host functions injected as guest globals. Returns the script's resolved
 * value (dumped out of the guest by JSON value) or `null` on any failure.
 *
 * Hard constraints:
 *  - sync-promise bridge (newPromise + executePendingJobs), NOT asyncify
 *  - a concurrent pump alongside resolvePromise so host-promises settle
 *  - every QuickJSHandle disposed before context dispose (else process abort)
 *  - NEVER THROWS — returns null on any error (per never-throw contract for agent())
 */
export async function runSandboxed(
  source: string,
  primitives: SandboxPrimitives,
  opts?: Partial<SandboxConstraints> & { seed?: number; runID?: string },
): Promise<unknown> {
  const QJS = await getQuickJS()
  const deadlineMs = opts?.deadlineMs ?? SCRIPT_DEADLINE_MS

  // --- Create runtime + context ---
  const rt = createSandboxRuntime({
    QJS,
    seed: opts?.seed,
    memoryMB: opts?.memoryMB,
    stackSize: opts?.stackSize,
    deadlineMs,
  })
  const ctx = rt.newContext()

  // Arena: every handle we create goes here and is disposed in `finally`.
  const arena: QuickJSHandle[] = []
  // Deferreds for async hooks: tracked so an UNSETTLED one (script returned
  // while a host-promise is still in flight) is still disposed before context
  // dispose — otherwise ctx.dispose() hard-aborts on the live GC object.
  const deferreds: QuickJSDeferredPromise[] = []
  const track = <H extends QuickJSHandle>(h: H): H => {
    arena.push(h)
    return h
  }

  try {
    // --- Inject host functions ---
    const hooks = buildHostHooks(primitives)
    injectHooks(ctx, hooks, track, deferreds)

    // --- Determinism hardening ---
    const seed = (opts?.seed ?? DEFAULT_PRNG_SEED) >>> 0
    hardenDeterminism(ctx, seed)

    // --- Run PRELUDE ---
    evalAndDiscard(ctx, PRELUDE, "workflow prelude error")

    // --- Inject args as guest global (by value) ---
    const argsHandle = marshalIn(ctx, primitives.args ?? null)
    ctx.setProp(ctx.global, "args", argsHandle)
    argsHandle.dispose()

    // --- Evaluate user script ---
    const wrapped = `(async () => {\n${source}\n})()`
    const promiseHandle = track(evalAndReturn(ctx, wrapped, "workflow script error"))

    // --- Concurrent pump (adaptive cadence backstop) ---
    const pump = startMicrotaskPump(rt)

    // --- Wall-clock deadline (hard kill via Promise.race) ---
    const { promise: deadline, timer: deadlineTimer } = createDeadlineRace(
      opts?.deadlineMs ?? SCRIPT_DEADLINE_MS,
    )

    try {
      const resolved = await Promise.race([
        ctx.resolvePromise(promiseHandle).then(
          (r) => ({ kind: 'resolved' as const, r }),
          (e) => ({ kind: 'rejected' as const, e })
        ),
        deadline.then(
          () => ({ kind: 'deadline' as const }),
          (e) => ({ kind: 'deadline' as const, err: e })
        )
      ])
      if (resolved.kind === 'deadline') {
        return null
      }
      if (resolved.kind === 'rejected') {
        return null
      }
      const r = (resolved as { kind: 'resolved', r: any }).r
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
  } catch (e: unknown) {
    // Never-throw contract: catch all errors, return null.
    return null
  } finally {
    // Dispose deferreds BEFORE the arena/context: an unsettled deferred
    // still owns live guest handles, and ctx.dispose() aborts the process
    // if any GC object is still alive. Disposing a settled deferred is a
    // no-op.
    for (const d of deferreds) {
      if (d.alive) d.dispose()
    }
    for (const h of arena) {
      if (h.alive) h.dispose()
    }
    ctx.dispose()
    rt.dispose()
  }
}

// ---------------------------------------------------------------------------
// Internal helpers — extracted to ./sandbox-runtime.ts, ./sandbox-eval.ts,
// ./sandbox-pump.ts, ./sandbox-bridge.ts (v0.16.0 Lane C Files 4-7).
// ---------------------------------------------------------------------------
