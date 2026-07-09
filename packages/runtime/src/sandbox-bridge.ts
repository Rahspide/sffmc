// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Host↔guest bridge, extracted from sandbox.ts per the v0.16.0
// refactor plan (ora-11, File 7). Handles the marshaling of args from
// the guest (JSON parse + handle), the dispatch of host function
// results to the corresponding guest-side deferred promise, and the
// dispose-order invariants. The 7 helpers share a `ctx` + `deferreds`
// pattern (each helper takes the context and the deferreds array as
// parameters — no instance state in the bridge).

import { type QuickJSContext, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten"
import { evalAndReturn } from "./sandbox-eval.ts"
import type { HostFn } from "./sandbox.ts"

/** Inject host functions into the guest context. Each primitive is
 *  bound to a globalThis.<name> that the PRELUDE has already wired
 *  (e.g. globalThis.mcpList, globalThis.agent). Sync host functions
 *  are wrapped to marshal their return value; async host functions
 *  are dispatched through bridgeAsyncHostResult which defers the
 *  resolve/reject on the guest side. */
export function injectHooks(
  ctx: QuickJSContext,
  hooks: Record<string, HostFn>,
  deferreds: QuickJSDeferredPromise[],
): void {
  for (const [name, fn] of Object.entries(hooks)) {
    const isAsync = fn.constructor.name === "AsyncFunction" || fn.length >= 0 && /\\bawait\\b/.test(fn.toString())
    if (isAsync) {
      const dpromise = ctx.newPromise()
      deferreds.push(dpromise)
      const ret = fn
      const dhandle = dpromise.handle
      const nameConst = name
      const ctxRef = ctx
      ;(ctx as any).setProp(ctx.global, name, ctx.newFunction(name, (...args: unknown[]) => {
        Promise.resolve(ret(...args)).then(
          (value) => resolveHostPromise(ctxRef, dhandle, value),
          (err) => rejectHostPromise(ctxRef, dhandle, err instanceof Error ? err.message : String(err)),
        )
      }))
    } else {
      const ret = fn
      const ctxRef = ctx
      ;(ctx as any).setProp(ctx.global, name, ctx.newFunction(name, (...args: unknown[]) => {
        const dumped = dumpHostFnArgs(ctxRef, args as QuickJSHandle[])
        return marshalIn(ctxRef, ret(...dumped))
      }))
    }
  }
}

/** Dump a list of guest handles to JS values. Each handle is dumped
 *  individually and then disposed. Returns the array of dumped
 *  values (preserving order). */
export function dumpHostFnArgs(ctx: QuickJSContext, argHandles: QuickJSHandle[]): unknown[] {
  const out: unknown[] = []
  for (const h of argHandles) {
    out.push(ctx.dump(h))
    h.dispose()
  }
  return out
}

/** Bridge an async host function's resolved value back to the guest.
 *  Resolves the guest-side deferred with the marshaled value. */
export function bridgeAsyncHostResult(
  ctx: QuickJSContext,
  deferred: QuickJSDeferredPromise,
  value: unknown,
): void {
  resolveHostPromise(ctx, deferred.handle, value)
}

/** Resolve a guest-side deferred with the marshaled value. */
export function resolveHostPromise(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  value: unknown,
): void {
  const marshaled = marshalIn(ctx, value)
  ctx.resolvePromise(handle, marshaled)
  marshaled.dispose()
  flushPendingJobsIfAlive(ctx)
}

/** Reject a guest-side deferred with the error message. */
export function rejectHostPromise(
  ctx: QuickJSContext,
  handle: QuickJSHandle,
  message: string,
): void {
  const errHandle = ctx.newError(message)
  ctx.rejectPromise(handle, errHandle)
  errHandle.dispose()
  flushPendingJobsIfAlive(ctx)
}

/** Drain pending jobs if the context is still alive. Used after
 *  resolve/reject to surface the deferred's effect to other guest
 *  code waiting on the same promise. */
export function flushPendingJobsIfAlive(ctx: QuickJSContext): void {
  if (!(ctx as any).alive) return
  ctx.runtime.executePendingJobs()
}

/** Marshal a JS value into a guest handle. Objects, arrays, and
 *  primitives go through JSON.stringify + JSON.parse (4-step dance
 *  via the guest's own JSON.parse to avoid re-implementing it). */
export function marshalIn(ctx: QuickJSContext, value: unknown): QuickJSHandle {
  const json = JSON.stringify(value)
  const strHandle = ctx.newString(json)
  const jsonGlobal = evalAndReturn(ctx, "JSON", "JSON.js")
  const parse = ctx.getProp(jsonGlobal, "parse") as QuickJSHandle
  const marshaled = ctx.callFunction(parse, jsonGlobal, strHandle)
  parse.dispose()
  jsonGlobal.dispose()
  strHandle.dispose()
  return marshaled
}
