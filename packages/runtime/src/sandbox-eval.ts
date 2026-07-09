// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Sandbox eval wrappers, extracted from sandbox.ts per the v0.16.0
// refactor plan (ora-11, File 5). Two thin helpers that wrap
// `ctx.evalCode()` with the right error-disposal order. Eval + handle
// dispose. No orchestration, no state.

import { type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten"

/** Evaluate `code` in `ctx` and dispose the result/error handle.
 *  Throws an Error on eval failure (after disposing the error handle). */
export function evalAndDiscard(ctx: QuickJSContext, code: string, label: string): void {
  const result = ctx.evalCode(code, label, { type: "global" })
  if (result.error) {
    const errStr = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`eval failed in ${label}: ${errStr}`)
  }
  result.value.dispose()
}

/** Evaluate `code` in `ctx` and return the result handle. Caller must
 *  dispose the handle. Throws on eval failure (after disposing the
 *  error handle). */
export function evalAndReturn(ctx: QuickJSContext, code: string, label: string): QuickJSHandle {
  const result = ctx.evalCode(code, label, { type: "global" })
  if (result.error) {
    const errStr = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`eval failed in ${label}: ${errStr}`)
  }
  return result.value
}
