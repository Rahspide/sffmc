// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/** Canonical /max command. Used in max-mode (trigger), auto-max (regex), watchdog (catch). */
export const MAX_COMMAND = "/max" as const

/** Regex matching `/max`, `/max reset [id]`, `/max clear [id]`. */
export const MAX_PATTERN = /^\/max(?:\s+(reset|clear)(?:\s+(\S+))?)?$/i

/** Default failure-count threshold for triggering escalation (auto-max,
 *  watchdog). Three strikes before promotion. */
export const DEFAULT_FAILURE_THRESHOLD = 3

/** Default candidate count for Max Mode parallel generation. Three
 *  candidates gives the judge enough spread to differentiate without
 *  blowing the budget cap. */
export const DEFAULT_CANDIDATE_COUNT = 3
