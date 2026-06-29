// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

import { parse as parseYaml } from "yaml"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import { createLogger } from "./logger.ts"
import safeRegex from "safe-regex"

const log = createLogger("sffmc/shared")

/**
 * Default star-height-1 repetition limit for `validateSafeRegex`.
 * Matches the limit used by `scripts/check-redos.ts` for built-in rules.
 */
const DEFAULT_SAFE_REPETITION_LIMIT = 25

/**
 * Validate a regex pattern is not vulnerable to ReDoS (catastrophic backtracking).
 * Wraps the `safe-regex` library with a sane default limit.
 *
 * Returns `true` for safe patterns, `false` for unsafe patterns OR patterns
 * with invalid regex syntax (safe-regex reports both as non-safe via its
 * internal try/catch). Callers that need to distinguish "unsafe" from "invalid
 * syntax" should run their own `new RegExp()` probe after this check.
 *
 * Pass-through of `safe-regex`'s interface: `pattern` may be a string or
 * `RegExp`; `opts.limit` overrides the default 25-repetition threshold.
 */
export function validateSafeRegex(
  pattern: string | RegExp,
  opts?: { limit?: number },
): boolean {
  try {
    return safeRegex(pattern, { limit: opts?.limit ?? DEFAULT_SAFE_REPETITION_LIMIT })
  } catch {
    // Defensive: safe-regex itself catches errors and returns false, but
    // any wrapper-level failure (e.g., import misconfig) is treated as
    // "unsafe" so callers conservatively reject.
    return false
  }
}

/**
 * Load plugin config by merging user YAML over defaults.
 *
 * - Reads `~/.config/SFFMC/<pluginName>.yaml` (or `opts.configHome/<pluginName>.yaml`)
 * - Missing file → returns `{ ...defaults }`
 * - Malformed YAML → returns `{ ...defaults }` (logs warning via createLogger, does NOT throw)
 * - Valid YAML → returns `{ ...defaults, ...parsed }` (user values win)
 * - If `opts.validate` is provided and throws, returns `{ ...defaults }`
 *   (logs warning). Callers use this to enforce schema constraints (e.g.,
 *   reject unsafe regex patterns, clamp numeric limits) without crashing
 *   on a user-supplied bad config — same fallback semantics as YAML parse
 *   failure.
 *
 * `validate` is invoked AFTER successful YAML parse. It receives the
 * unknown-typed parsed value and MUST return a fully-typed `T` (or throw).
 * A throwing validator is the supported way to reject the entire config;
 * a non-throwing sanitizer may return a filtered/corrected shape.
 */
export async function loadConfig<T extends object>(
  pluginName: string,
  defaults: T,
  opts?: { configHome?: string; validate?: (parsed: unknown) => T },
): Promise<T> {
  const baseDir = opts?.configHome ?? resolve(homedir(), ".config/SFFMC")
  const configPath = resolve(baseDir, `${pluginName}.yaml`)
  if (!existsSync(configPath)) return { ...defaults }
  let parsed: unknown
  try {
    const rawYaml = readFileSync(configPath, "utf-8")
    parsed = parseYaml(rawYaml)
  } catch (err) {
    log.warn(` failed to parse ${configPath}:`, err)
    return { ...defaults }
  }
  if (opts?.validate) {
    try {
      return opts.validate(parsed)
    } catch (err) {
      log.warn(` validation failed for ${configPath}:`, err)
      return { ...defaults }
    }
  }
  return { ...defaults, ...(parsed as Partial<T>) }
}
