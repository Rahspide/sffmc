// SPDX-License-Identifier: MIT
// @sffmc/utilities — see ../../LICENSE

import { parse as parseYaml } from "yaml"
import { readFileSync, existsSync } from "fs"
import { resolve } from "path"
import { homedir } from "os"
import { createLogger } from "./logger.ts"
import safeRegex from "safe-regex"
import * as v from "valibot"

const log = createLogger("sffmc/shared")

/**
 * Default star-height-1 repetition limit for `validateSafeRegex`.
 * Matches the limit used by `scripts/check-redos.ts` for built-in rules.
 *
 * Exported as `SAFE_REPETITION_LIMIT` so other packages (e.g. safety/rules)
 * share the same threshold instead of duplicating `const X = 25` literals
 * that drift independently.
 */
export const SAFE_REPETITION_LIMIT = 25

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
    return safeRegex(pattern, { limit: opts?.limit ?? SAFE_REPETITION_LIMIT })
  } catch (e) {
    log.warn({ err: e, pattern: String(pattern) }, "validateSafeRegex: wrapper-level failure (rejecting as unsafe)")
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
 * - If `opts.schema` is provided, the YAML output is decoded through it BEFORE
 *   the optional validate callback runs. Schema failures fall back to defaults.
 * - If `opts.validate` is provided and throws, returns `{ ...defaults }`
 *   (logs warning). Callers use this to enforce schema constraints (e.g.,
 *   reject unsafe regex patterns, clamp numeric limits) without crashing
 *   on a user-supplied bad config — same fallback semantics as YAML parse
 *   failure.
 *
 * `validate` is invoked AFTER successful YAML parse + optional schema decode.
 * The callback receives the typed `T` (or `Partial<T>` when no schema is
 * supplied, since raw YAML may omit fields). A throwing validator is the
 * supported way to reject the entire config; a non-throwing sanitizer may
 * return a filtered/corrected shape.
 */
export async function loadConfig<T extends object>(
  pluginName: string,
  defaults: T,
  opts?: {
    configHome?: string
    schema?: v.GenericSchema<unknown, T>
    validate?: (parsed: T) => T
  },
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
  let typed: T
  if (opts?.schema) {
    try {
      typed = v.parse(opts.schema, parsed)
    } catch (err) {
      log.warn(` schema validation failed for ${configPath}:`, err)
      return { ...defaults }
    }
  } else {
    // SAFETY: invariant — parsed comes from yaml parser above; cast to Partial<T> for typed merge with defaults
    typed = { ...defaults, ...(parsed as Partial<T>) } as T
  }
  if (opts?.validate) {
    try {
      return opts.validate(typed)
    } catch (err) {
      log.warn(` validation failed for ${configPath}:`, err)
      return { ...defaults }
    }
  }
  return typed
}
