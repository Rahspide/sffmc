// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/**
 * Extract an error class/type from a tool output (string, object, or unknown).
 * Replaces duplicated `extractErrorType()` in auto-max (index.ts:34-47) and watchdog (index.ts:29-41).
 * Patterns: ENOENT|EACCES|EPERM|EAGAIN|ECONNREFUSED|ETIMEDOUT|ERR_*|Error:|error:
 * Falls back to `o.code` or `o.name`, then "UNKNOWN".
 */
export function extractErrorType(output: unknown): string {
  if (typeof output === "string") {
    const errMatch = output.match(
      /(ENOENT|EACCES|EPERM|EAGAIN|ECONNREFUSED|ETIMEDOUT|ERR_|Error:|error:)/i,
    )
    if (errMatch) return errMatch[1].toUpperCase()
  }
  if (output && typeof output === "object") {
    const o = output as Record<string, unknown>
    if (typeof o.code === "string") return o.code
    if (typeof o.name === "string") return o.name
  }
  return "UNKNOWN"
}

/**
 * Strict tool-error detection. Uses watchdog's pattern (not auto-max's loose `/error|fail/i`
 * which produced false positives on "errorless" or "failsafe" substrings).
 * Replaces divergent regexes in auto-max (index.ts:100-102) and watchdog (index.ts:91-94).
 */
export function isToolError(output: unknown): boolean {
  if (output == null) return false
  if (typeof output !== "string") return false
  if (output.length > 4096) return true // long outputs are likely error dumps
  return /(?:^Error[:\s]|ERR_[A-Z_]+|ENOENT|EACCES|EPERM|EAGAIN|ETIMEDOUT|ECONNREFUSED|throw\s+new\s+Error|Error:\s*\w)/i.test(output)
}
