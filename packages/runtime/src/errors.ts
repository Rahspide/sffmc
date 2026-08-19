/**
 * Coerce an unknown thrown value to a human-readable string.
 * Used at the boundary where an Error (or non-Error) is being
 * routed into a string-typed field (e.g. failRun, log, journal).
 *
 * `e` is typed as the universal JS value union (everything
 * `throw` accepts in JS). Callers from `catch (e)` blocks pass
 * the raw thrown value before parsing.
 */

export function toErrorMessage(
  e: string | number | bigint | boolean | symbol | object | null | undefined,
): string {
  if (e instanceof Error) return e.message
  if (typeof e === "object" && e !== null && "message" in e) {
    const msg = (e as { message: unknown }).message
    if (typeof msg === "string") return msg
  }
  return String(e)
}
