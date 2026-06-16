// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/** Canonical /max command. Used in max-mode (trigger), auto-max (regex), watchdog (catch). */
export const MAX_COMMAND = "/max" as const

/** Recognized /max subcommands. */
export const MAX_SUBCOMMANDS = ["execute", "reset", "clear"] as const

export type MaxSubcommand = typeof MAX_SUBCOMMANDS[number]

/** Regex matching `/max`, `/max reset [id]`, `/max clear [id]`. */
export const MAX_PATTERN = /^\/max(?:\s+(reset|clear)(?:\s+(\S+))?)?$/i
