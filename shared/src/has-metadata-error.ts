// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/**
 * Returns true if `meta.error` is meaningfully set (not undefined, null, or false).
 * Mirrors the inline 3-clause guard used in auto-max and watchdog.
 */
export function hasMetadataError(
  meta: { error?: unknown } | null | undefined,
): boolean {
  return (
    meta?.error !== undefined &&
    meta?.error !== null &&
    meta?.error !== false
  );
}
