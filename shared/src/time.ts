// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/** Seconds per day. Single source of truth for date arithmetic. */
export const SECONDS_PER_DAY = 24 * 60 * 60

/** Current Unix time in seconds (floored). Single source of truth so test
 *  fixtures, journal writes, and staleness checks stay in lock-step. */
export const unixNow = (): number => Math.floor(Date.now() / 1000)
