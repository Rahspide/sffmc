/**
 * Coerce an unknown thrown value to a human-readable string.
 * Used at the boundary where an Error (or non-Error) is being
 * routed into a string-typed field (e.g. failRun, log, journal).
 *
 * `e` is typed as the universal JS value union (everything
 * `throw` accepts in JS). Callers from `catch (e)` blocks pass
 * the raw thrown value before parsing.
 */

import * as v from "valibot"

/** Valibot schema for "anything that looks like an Error but isn't an
 *  instance of Error" — a non-null object with a string `message`
 *  field. Used at the I/O boundary to check the `message` accessor
 *  before reading it, replacing the historical `typeof === "object"`
 *  narrowing. */
const ErrorLikeSchema = v.object({ message: v.string() })

export function toErrorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (v.is(ErrorLikeSchema, e)) return e.message
  return String(e)
}
