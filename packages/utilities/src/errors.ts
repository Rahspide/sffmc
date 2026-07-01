// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

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

/** Tool-output length above which isToolError() returns true. Long outputs
 *  are very likely to be an error dump (stack trace, error JSON, etc.).
 *  Single source of truth so the watchdog safety/test guard and the
 *  production error detector stay in sync. */
export const LONG_OUTPUT_THRESHOLD = 4096

/**
 * Strict tool-error detection. Uses watchdog's pattern (not auto-max's loose `/error|fail/i`
 * which produced false positives on "errorless" or "failsafe" substrings).
 * Replaces divergent regexes in auto-max (index.ts:100-102) and watchdog (index.ts:91-94).
 */
export function isToolError(output: unknown): boolean {
  if (output == null) return false
  if (typeof output !== "string") return false
  if (output.length > LONG_OUTPUT_THRESHOLD) return true // long outputs are likely error dumps
  return /(?:^Error[:\s]|ERR_[A-Z_]+|ENOENT|EACCES|EPERM|EAGAIN|ETIMEDOUT|ECONNREFUSED|throw\s+new\s+Error|Error:\s*\w)/i.test(output)
}

/** First `{...}` block in a string. Used by judge.ts (max-mode and extra) to
 *  extract the JSON object out of LLM responses that may include prose or
 *  markdown fences around the verdict. Single source of truth so the two
 *  judge implementations can't drift to different regexes. */
export const JSON_OBJECT_RE = /\{[\s\S]*\}/

/** Thrown by code paths that require `ctx.client.session.message()` but find
 *  it unavailable (e.g., running in a non-OpenCode test harness). Single
 *  source of truth for the message so callers can `instanceof`-check and
 *  the test fixtures can grep for the canonical string. */
export class NoLLMClientError extends Error {
  constructor() {
    super("ctx.client.session.message() not available")
    this.name = "NoLLMClientError"
  }
}
