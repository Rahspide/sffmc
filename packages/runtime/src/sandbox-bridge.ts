// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Host↔guest bridge, extracted from sandbox.ts per the v0.16.0
// refactor plan (ora-11, File 7). Handles the marshaling of args from
// the guest (JSON parse + handle), the dispatch of host function
// results to the corresponding guest-side deferred promise, and the
// dispose-order invariants.

import {
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
} from "quickjs-emscripten"
import { evalAndReturn } from "./sandbox-eval.ts"
import { toErrorMessage } from "./errors.ts"

/** An injected host function: receives already-marshaled JS args,
 *  returns a JS value or Promise. */
export type HostFn = (...args: unknown[]) => unknown | Promise<unknown>

/** Wire host functions into the guest as globals. */
export function injectHooks(
  ctx: QuickJSContext,
  hooks: Record<string, HostFn>,
  track: <H extends QuickJSHandle>(h: H) => H,
  deferreds: QuickJSDeferredPromise[],
): void {
  for (const [name, fn] of Object.entries(hooks)) {
    const fnHandle = ctx.newFunction(name, (...argHandles: QuickJSHandle[]) => {
      const args = dumpHostFnArgs(ctx, argHandles)
      const out = fn(...args)
      if (out instanceof Promise) {
        return bridgeAsyncHostResult(ctx, out, deferreds)
      }
      // Synchronous return — marshal into the guest.
      return marshalIn(ctx, out)
    })
    ctx.setProp(ctx.global, name, track(fnHandle))
  }
}

/** Dump a guest arg-handle array into a host-side JS array, disposing
   *  each handle as we go. Disposes each handle in a try/finally so a
   *  throw from `ctx.dump(h)` (e.g. on a non-serializable handle) does
   *  not leak the guest handle. */
export function dumpHostFnArgs(ctx: QuickJSContext, argHandles: QuickJSHandle[]): unknown[] {
  const args: unknown[] = []
  for (const h of argHandles) {
    try {
      args.push(ctx.dump(h))
    } finally {
      h.dispose()
    }
  }
  return args
}

/** Bridge an async host result into a guest promise. Wires up the
 *  then/settled handlers, marshals the resolved value (or the rejected
 *  message) into the guest, and tracks the deferred so the script's
 *  outer `finally` can dispose it before context dispose. */
export function bridgeAsyncHostResult(
  ctx: QuickJSContext,
  out: Promise<unknown>,
  deferreds: QuickJSDeferredPromise[],
): QuickJSHandle {
  const promise = ctx.newPromise()
  deferreds.push(promise)
  out.then(
    (value) => resolveHostPromise(ctx, promise, value),
    (err) => rejectHostPromise(ctx, promise, err),
  )
  promise.settled.then(() => flushPendingJobsIfAlive(ctx))
  return promise.handle
}

/** Marshal the resolved `value` into the guest and resolve the deferred. */
export function resolveHostPromise(
  ctx: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  value: unknown,
): void {
  if (!ctx.alive) return
  const vh = marshalIn(ctx, value)
  deferred.resolve(vh)
  vh.dispose()
  flushPendingJobsIfAlive(ctx)
}

/** Marshal the rejected `err` (as a string) into the guest and reject
 *  the deferred. */
export function rejectHostPromise(
  ctx: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  err: unknown,
): void {
  if (!ctx.alive) return
  const msg = toErrorMessage(err)
  const eh = ctx.newString(msg)
  deferred.reject(eh)
  eh.dispose()
  flushPendingJobsIfAlive(ctx)
}

/** Drain guest pending jobs after a settle, if the context is still alive. */
export function flushPendingJobsIfAlive(ctx: QuickJSContext): void {
  if (ctx.alive) ctx.runtime.executePendingJobs()
}

/** Marshal a host JS value INTO the guest (by copy via JSON for structured
 *  data, direct for primitives).
 *
 *  Handle-leak invariants (gen-2 #8): the JSON-round-trip path acquires
 *  three guest resources (`json`, `parseFn`, the `callFunction` result)
 *  in strict order. The original implementation disposed `json` and
 *  `parseFn` ONLY on the happy path — when `ctx.unwrapResult` threw on
 *  the parse-evaluation result, `json` was leaked; when
 *  `ctx.callFunction` threw, BOTH `json` AND `parseFn` were leaked.
 *  Long-running workflows marshal thousands of values per step, so this
 *  leaked a handle per call. The fix wraps each acquisition in its own
 *  `try/finally` so disposal runs regardless of subsequent throws. The
 *  return path's `ctx.unwrapResult(callRes)` consumes the call result
 *  internally — no separate dispose needed. */
export function marshalIn(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  if (value === undefined) return ctx.undefined
  if (value === null) return ctx.null
  if (typeof value === "string") return ctx.newString(value)
  if (typeof value === "number") return ctx.newNumber(value)
  if (typeof value === "boolean") return value ? ctx.true : ctx.false

  const json = ctx.newString(JSON.stringify(value))
  let parseFn: QuickJSHandle | undefined
  let callRes: { value?: unknown; error?: unknown; dispose: () => void } | undefined
  try {
    parseFn = ctx.unwrapResult(ctx.evalCode("JSON.parse"))
    try {
      callRes = ctx.callFunction(parseFn, ctx.undefined, json) as typeof callRes
    } finally {
      parseFn.dispose()
    }
  } catch (err) {
    // Ensure all live handles are disposed when any step throws. The inner
    // finally already disposed parseFn on the callFunction path; this catch
    // covers the unwrapResult-threw path (parseFn never assigned) and is
    // also the safety net for any future acquisition added inside the inner
    // try.
    json.dispose()
    throw err
  }
  json.dispose()
  return ctx.unwrapResult(callRes as Parameters<typeof ctx.unwrapResult>[0])
}

