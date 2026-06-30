// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export function createLogger(prefix: string): Logger {
  return {
    info: (...args: unknown[]) => console.log(`[${prefix}]`, ...args),
    warn: (...args: unknown[]) => console.warn(`[${prefix}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${prefix}]`, ...args),
    debug: (...args: unknown[]) => console.debug(`[${prefix}]`, ...args),
  }
}
