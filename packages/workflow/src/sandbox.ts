// SPDX-License-Identifier: MIT
// @sffmc/workflow — see ../../LICENSE

import {
  getQuickJS,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten"
import type { SandboxConstraints } from "./types"
import {
  SCRIPT_DEADLINE_MS,
  getSandboxMemoryMB,
  getSandboxStackSize,
} from "./constants.ts"

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
//
// max-stack-size now defer to `getSandboxMemoryMB()` /
// `getSandboxStackSize()` from `./constants.ts`, which read from
// `~/.config/SFFMC/workflow.yaml` (default 64 MiB / 1 MiB). When no
// caller-supplied `memoryMB` is given AND the YAML has not been loaded,
// the prior hardcoded behavior (64 MiB) is preserved via the default in
// `DEFAULT_WORKFLOW_EXTENDED_CONFIG`.

/** Fallback seed when no caller-supplied seed is set. Stable so existing
 *  single-shot tests stay deterministic. The runtime always passes
 *  seed=hash(runID) so production paths never see this default. */
const DEFAULT_PRNG_SEED = 0x9e3779b9               // fallback

// ---------------------------------------------------------------------------
// Guest-side PRELUDE — pure-JS helpers that need no host round-trip.
// parallel / pipeline do NO throttling — concurrency is enforced by the host
// semaphore inside the agent() hook. They also do NOT catch: a throwing
// thunk/stage rejects the batch (fails loud with the guest stack).
// agent() is never-throw for agent failures (returns null), so the only
// throws reaching here are script-logic errors, which SHOULD fail loud
// rather than become silent nulls that poison downstream .map/.filter.
//
// mcpList / mcpCall are host-injected (one round-trip each) and bound here
// into a single `mcp` object so guest scripts use `mcp.list()` / `mcp.call()`.
// The host side tracks per-run budget + recursion (see mcp.ts).
// ---------------------------------------------------------------------------

const PRELUDE = `
globalThis.parallel = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t)));
globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)), Promise.resolve(item))));
// Minimal, deterministic URL for dedup/host-extraction in workflow scripts.
// The bare QuickJS guest has no Web URL. Covers protocol/hostname/pathname/
// search/hash — enough for normURL-style dedup — and THROWS on inputs without
// a scheme+host, so scripts' try/catch fallbacks behave like the real URL.
globalThis.URL = class URL {
  constructor(input) {
    const str = String(input);
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\\/\\/([^/?#]*)([^?#]*)(\\?[^#]*)?(#.*)?$/.exec(str);
    if (!m) throw new TypeError("Invalid URL: " + str);
    this.protocol = m[1].toLowerCase();
    this.hostname = m[2];
    this.pathname = m[3] || "/";
    this.search = m[4] || "";
    this.hash = m[5] || "";
    this.host = m[2];
  }
  toString() { return this.protocol + "//" + this.host + this.pathname + this.search + this.hash; }
};
// MCP bridge — bound to host-injected mcpList / mcpCall (see injectHooks).
// When the runtime does not wire MCP support, both globals are set to no-ops
// (mcpList returns []; mcpCall rejects with a clear error). Scripts can
// therefore use mcp.list() and mcp.call(name, args) unconditionally.
globalThis.mcp = {
  list: (...args) => globalThis.mcpList(...args),
  call: (...args) => globalThis.mcpCall(...args),
};
`

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

  // --- Build hooks map (host functions only; skip PRELUDE keys + args) ---
  const PRELUDE_KEYS = new Set(["parallel", "pipeline", "args"])
  const hooks: Record<string, HostFn> = {}
  for (const key of Object.keys(primitives)) {
    if (PRELUDE_KEYS.has(key)) continue
    const fn = (primitives as unknown as Record<string, unknown>)[key]
    if (typeof fn === "function") {
      hooks[key] = fn as HostFn
    }
  }

  // --- Create runtime + context ---
  const rt = QJS.newRuntime()
    // YAML-configured value (via `getSandboxMemoryMB()`), which falls back
  // to 64 MiB when no override is set. The previous hardcoded `DEFAULT_MEMORY`
  // constant is preserved as `DEFAULT_MEMORY_BYTES` for any code paths
  // that still need to compute byte counts directly.
  const memoryMB = opts?.memoryMB ?? getSandboxMemoryMB()
  rt.setMemoryLimit(memoryMB * 1024 * 1024)
    // the YAML config via `getSandboxStackSize()` (default 1 MiB).
  rt.setMaxStackSize(getSandboxStackSize())
  rt.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + (opts?.deadlineMs ?? SCRIPT_DEADLINE_MS)),
  )
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
    injectHooks(ctx, hooks, track, deferreds)

    // --- Determinism hardening ---
    // The guest is a bare quickjs-emscripten JS engine — no Web/Node APIs
    // exist (no crypto/performance/fetch/timers/process/Temporal/gc; all
    // already undefined). We neutralize the JS built-ins whose output or
    // timing is nondeterministic so resume replay stays sound:
    //   - Date — deleted (nondeterministic wall-clock)
    //   - Math.random — REPLACED with a SEEDED PRNG (mulberry32)
    //   - WeakRef / FinalizationRegistry — deleted (GC liveness callbacks)
    const seed = (opts?.seed ?? DEFAULT_PRNG_SEED) >>> 0
    const stripResult = ctx.evalCode(`
      delete globalThis.Date;
      (function () {
        // mulberry32 — tiny seeded PRNG; deterministic for a given seed.
        let s = ${seed} >>> 0;
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
    `)
    if (stripResult.error) {
      stripResult.error.dispose()
    } else {
      stripResult.value.dispose()
    }

    // --- Run PRELUDE ---
    const preResult = ctx.evalCode(PRELUDE)
    if (preResult.error) {
      const err = ctx.dump(preResult.error)
      preResult.error.dispose()
      throw new Error(`workflow prelude error: ${typeof err === "string" ? err : JSON.stringify(err)}`)
    }
    preResult.value.dispose()

    // --- Inject args as guest global (by value) ---
    const argsHandle = marshalIn(ctx, primitives.args ?? null)
    ctx.setProp(ctx.global, "args", argsHandle)
    argsHandle.dispose()

    // --- Evaluate user script ---
    const wrapped = `(async () => {\n${source}\n})()`
    const evalRes = ctx.evalCode(wrapped)
    if (evalRes.error) {
      const err = ctx.dump(evalRes.error)
      evalRes.error.dispose()
      throw new Error(`workflow script error: ${typeof err === "string" ? err : JSON.stringify(err)}`)
    }
    const promiseHandle = track(evalRes.value)

    // --- Concurrent pump ---
    // A BACKSTOP that drains guest microtasks while we await the guest
    // promise. NOTE: agent() results do NOT depend on this loop's latency —
    // injectHooks already calls executePendingJobs() synchronously the
    // moment a host promise settles. This pump only catches guest-INTERNAL
    // pending jobs (e.g. parallel()'s Promise.all advancing between host
    // settles).
    //
    // Adaptive cadence to avoid idle CPU churn: stays FAST right after
    // finding work, decays to SLOW when idle. NEVER stops polling (cannot
    // deadlock) — worst case adds ≤ SLOW_MS latency.
    const FAST_MS = 1
    const SLOW_MS = 50
    const FAST_WINDOW = 50
    let pumpTimer: ReturnType<typeof setTimeout> | undefined
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
    pumpTimer = setTimeout(pumpOnce, FAST_MS)
    pumpTimer.unref?.()

    // --- Wall-clock deadline (hard kill via Promise.race) ---
    // The runtime interrupt handler only fires during guest bytecode
    // execution, so it kills `while(true){}` but NOT a guest parked on a
    // pending host promise. This timer races resolvePromise and rejects
    // when the budget elapses.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new Error("workflow script deadline exceeded")),
        opts?.deadlineMs ?? SCRIPT_DEADLINE_MS,
      )
    })

    try {
      const resolved = await Promise.race([ctx.resolvePromise(promiseHandle), deadline])
      if (resolved.error) {
        const err = ctx.dump(resolved.error)
        resolved.error.dispose()
        throw new Error(`workflow script rejected: ${typeof err === "string" ? err : JSON.stringify(err)}`)
      }
      const valueHandle = track(resolved.value)
      return ctx.dump(valueHandle)
    } finally {
      clearTimeout(pumpTimer)
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
// Internal helpers
// ---------------------------------------------------------------------------

/** Wire host functions into the guest as globals. */
function injectHooks(
  ctx: QuickJSContext,
  hooks: Record<string, HostFn>,
  track: <H extends QuickJSHandle>(h: H) => H,
  deferreds: QuickJSDeferredPromise[],
): void {
  for (const [name, fn] of Object.entries(hooks)) {
    const fnHandle = ctx.newFunction(name, (...argHandles: QuickJSHandle[]) => {
      const args: unknown[] = []
      for (const h of argHandles) {
        args.push(ctx.dump(h))
        h.dispose()
      }
      const out = fn(...args)

      if (out instanceof Promise) {
        const promise = ctx.newPromise()
        deferreds.push(promise)
        out.then(
          (value) => {
            // A late settle may arrive after the context is disposed
            // (script returned without awaiting). Bail before touching
            // a dead context.
            if (!ctx.alive) return
            const vh = marshalIn(ctx, value)
            promise.resolve(vh)
            vh.dispose()
            ctx.runtime.executePendingJobs()
          },
          (err) => {
            if (!ctx.alive) return
            const eh = ctx.newString(
              err instanceof Error ? err.message : String(err),
            )
            promise.reject(eh)
            eh.dispose()
            ctx.runtime.executePendingJobs()
          },
        )
        promise.settled.then(() => {
          if (ctx.alive) ctx.runtime.executePendingJobs()
        })
        return promise.handle
      }

      // Synchronous return — marshal into the guest.
      return marshalIn(ctx, out)
    })
    ctx.setProp(ctx.global, name, track(fnHandle))
  }
}

/** Marshal a host JS value INTO the guest (by copy via JSON for structured
 *  data, direct for primitives). */
function marshalIn(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return ctx.undefined
  if (value === null) return ctx.null
  if (typeof value === "string") return ctx.newString(value)
  if (typeof value === "number") return ctx.newNumber(value)
  if (typeof value === "boolean") return value ? ctx.true : ctx.false

  const json = ctx.newString(JSON.stringify(value))
  const parseRes = ctx.evalCode("JSON.parse")
  const parseFn = ctx.unwrapResult(parseRes)
  const out = ctx.callFunction(parseFn, ctx.undefined, json)
  json.dispose()
  parseFn.dispose()
  return ctx.unwrapResult(out)
}
