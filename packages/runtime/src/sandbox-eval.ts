// SPDX-License-Identifier: MIT
// @sffmc/runtime — see ../../LICENSE

// Sandbox eval wrappers, extracted from sandbox.ts per the v0.16.0
// refactor plan (ora-11, File 5). Two thin helpers that wrap
// `ctx.evalCode()` with the right error-disposal order. No
// orchestration, no state.

import { type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten"

/** Eval a guest expression and discard its return value. Throws a
 *  labelled error if the eval failed, dumping the guest error to a
 *  string first. */
export function evalAndDiscard(ctx: QuickJSContext, code: string, label: string): void {
  const result = ctx.evalCode(code)
  if (result.error) {
    const err = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`${label}: ${typeof err === "string" ? err : JSON.stringify(err)}`)
  }
  result.value.dispose()
}

/** Eval a guest expression and return its live handle. Caller is
 *  responsible for disposing the returned handle. Throws a labelled
 *  error on eval failure (after disposing the error handle). */
export function evalAndReturn(ctx: QuickJSContext, code: string, label: string): QuickJSHandle {
  const result = ctx.evalCode(code)
  if (result.error) {
    const err = ctx.dump(result.error)
    result.error.dispose()
    throw new Error(`${label}: ${typeof err === "string" ? err : JSON.stringify(err)}`)
  }
  return result.value
}

