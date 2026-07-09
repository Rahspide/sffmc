/**
 * Coerce an unknown thrown value to a human-readable string.
 * Used at the boundary where an Error (or non-Error) is being
 * routed into a string-typed field (e.g. failRun, log, journal).
 */
export function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}