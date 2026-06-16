// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

export interface Logger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}

export function createLogger(prefix: string): Logger {
  return {
    info: (...args: any[]) => console.log(`[${prefix}]`, ...args),
    warn: (...args: any[]) => console.warn(`[${prefix}]`, ...args),
    error: (...args: any[]) => console.error(`[${prefix}]`, ...args),
    debug: (...args: any[]) => console.debug(`[${prefix}]`, ...args),
  }
}
