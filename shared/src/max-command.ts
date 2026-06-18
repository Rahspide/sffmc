// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/** Canonical /max command. Used in max-mode (trigger), auto-max (regex), watchdog (catch). */
export const MAX_COMMAND = "/max" as const

/** Regex matching `/max`, `/max reset [id]`, `/max clear [id]`. */
export const MAX_PATTERN = /^\/max(?:\s+(reset|clear)(?:\s+(\S+))?)?$/i
