// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/** Seconds per day. Single source of truth for date arithmetic. */
export const SECONDS_PER_DAY = 24 * 60 * 60

let _clock: () => number = () => Math.floor(Date.now() / 1000)

/** Current wall clock time in **seconds** (floored). The return unit is
 *  seconds — matching the existing `time_created` / `time_updated`
 *  column conventions in the workflow and memory databases — so call
 *  sites that subtract `SECONDS_PER_DAY` keep working without changes.
 *
 *  The clock is read through `_clock`, which defaults to
 *  `() => Math.floor(Date.now() / 1000)`. Tests can pin time with
 *  `__setClock(() => fixedSeconds)` and restore with `__resetClock()`. */
export function unixNow(): number {
  return _clock()
}

/** Override the clock used by `unixNow`. Pass `null` (or call
 *  `__resetClock()`) to restore the real wall clock. The override is
 *  process-global — every consumer of `unixNow` sees the same value —
 *  so tests must `__resetClock()` in `afterEach` to avoid leaking
 *  state into other tests. */
export function __setClock(fn: (() => number) | null): void {
  _clock = fn ?? (() => Math.floor(Date.now() / 1000))
}

/** Restore the default wall-clock behavior. Equivalent to
 *  `__setClock(null)` but clearer at the call site. */
export function __resetClock(): void {
  _clock = () => Math.floor(Date.now() / 1000)
}
