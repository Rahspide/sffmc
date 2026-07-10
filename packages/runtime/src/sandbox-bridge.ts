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
 *  data, direct for primitives). */
export function marshalIn(ctx: QuickJSContext, value: unknown): QuickJSHandle {
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

