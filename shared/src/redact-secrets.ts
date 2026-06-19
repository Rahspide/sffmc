// SPDX-License-Identifier: MIT
// @sffmc/shared — see ../../LICENSE

/**
 * Shared redaction helper. Three pure functions, no I/O at import time,
 * no module-level mutable state except the rules cache (reset via
 * `__resetRedactionCache()` in tests).
 *
 * Design: `docs/slim/v0-14-redaction-grace-design.md` §2 (M5 + M6 + L1 + L2).
 *
 * Composite-pattern compliance: helper is pure, has no dependencies on any
 * plugin package. The M5 caller (extra/checkpoint) and M6 caller
 * (extra/dream) and L1/L2 callers (memory/watcher, memory/recon) all
 * import from here.
 */

import { basename } from "node:path"
import { loadConfig } from "./config.ts"
import { createLogger } from "./logger.ts"

const log = createLogger("sffmc/shared")

/** Categories of redaction, used as the marker suffix `[REDACTED:<id>]`. */
export type RedactionCategory =
  | "env-file"
  | "private-key"
  | "api-key-assignment"
  | "password-assignment"
  | "token-assignment"
  | "bearer-header"
  | "basic-auth-header"
  | "cloud-credential"
  | "filename-credentials"
  | "filename-secrets"
  | "filename-password"
  | "filename-token"
  | "filename-api-key"
  | "filename-private-key"
  | "private-key-pem"
  | "filename-rule"
  | "sourcepath-rule"

/** Result of redacting a string. */
export interface RedactionResult {
  /** Text with all sensitive substrings replaced by `[REDACTED:<category>]`. */
  redacted: string
  /** Categories that fired, in order of first occurrence. */
  categories: ReadonlyArray<RedactionCategory>
  /** Count of redactions applied. Useful for telemetry and test assertions. */
  count: number
}

/** Internal rule shape — not exported. */
interface RedactionRule {
  /** Stable identifier — used for the `[REDACTED:<id>]` marker. */
  id: RedactionCategory
  /** Regex used for matching. Compiled once, cached. */
  pattern: RegExp
  /** If true, this rule applies to filename basenames only.
   *  If false (or omitted), this rule applies to full source paths AND to text content. */
  filenameOnly?: boolean
  /** Human-readable description for audit logs and the example YAML. */
  description: string
}

/**
 * Built-in rule catalogue. Anchored to basename (filename rules) or unanchored
 * (path + content rules). The list shape is fixed; do not reorder without
 * updating test #24 (aws_secret_access_key order). All regexes use linear
 * character classes — no nested quantifiers, no backreferences.
 */
const BUILTIN_RULES: ReadonlyArray<RedactionRule> = [
  // A — env files (filename-only)
  { id: "env-file", pattern: /^\.env(\.[\w-]+)?$/i, filenameOnly: true, description: ".env and .env.*" },
  // B — credential filenames (replaces L1's over-broad list)
  { id: "filename-credentials", pattern: /^credentials(\.[\w-]+)?$/i, filenameOnly: true, description: "credentials.{json,yaml,txt,md}" },
  { id: "filename-secrets", pattern: /^secrets?(\.[\w-]+)?$/i, filenameOnly: true, description: "secret / secrets" },
  { id: "filename-password", pattern: /^passwords?(\.[\w-]+)?$/i, filenameOnly: true, description: "password / passwords" },
  { id: "filename-token", pattern: /^tokens?(\.[\w-]+)?$/i, filenameOnly: true, description: "token / tokens" },
  { id: "filename-api-key", pattern: /^api[_-]?keys?(\.[\w-]+)?$/i, filenameOnly: true, description: "api_key / apikey / api-key" },
  { id: "filename-private-key", pattern: /^private[_-]?keys?(\.[\w-]+)?$/i, filenameOnly: true, description: "private_key / private-key" },
  // B' — source-path rules (L2 preserved behavior). Match sensitive
  // directory names anywhere in the path. A file inside a `secrets/`
  // directory leaks context regardless of the file's basename.
  { id: "sourcepath-rule", pattern: /(^|\/)secrets?(\/|$)/i, description: "paths containing /secrets/" },
  { id: "sourcepath-credentials", pattern: /(^|\/)credentials(\/|$|\.)/i, description: "paths containing /credentials/" },
  { id: "sourcepath-private", pattern: /(^|\/)private(\/|$|\.)/i, description: "paths containing /private/" },
  // C — PEM private keys (M5.2 v0.14.1: full block — header, body, footer)
  // The base64-encoded key material between BEGIN and END markers leaks the
  // private key even after the header line is redacted, so the regex matches
  // the entire armored block (non-greedy body) and `redactSecrets()` replaces
  // the whole match with a single `[REDACTED:private-key-pem]` marker.
  { id: "private-key-pem", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/g, description: "PEM-armored private key blocks (header + body + footer)" },
  // D — inline credential assignments
  { id: "api-key-assignment", pattern: /(api[_-]?key|apikey)\s*[=:]\s*["']?([A-Za-z0-9_+\-\/=]{16,})["']?/gi, description: "api_key=... or apiKey: ..." },
  { id: "password-assignment", pattern: /(password|passwd|pwd)\s*[=:]\s*["']?([^\s"']{6,})["']?/gi, description: "password=... or pwd: ..." },
  { id: "token-assignment", pattern: /(?:access[_-]?token|auth[_-]?token|bearer)\s*[=:]\s*["']?([A-Za-z0-9_+\-\/\.=]{16,})["']?/gi, description: "access_token=..., auth_token: ..., bearer=..." },
  { id: "bearer-header", pattern: /(?:authorization|auth):\s*bearer\s+([A-Za-z0-9_+\-\/\.=]{16,})/gi, description: "Authorization: Bearer <token>" },
  { id: "basic-auth-header", pattern: /(?:authorization|auth):\s*basic\s+([A-Za-z0-9+\/=]{8,})/gi, description: "Authorization: Basic <base64>" },
  { id: "cloud-credential", pattern: /(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_\-]{35}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+)/g, description: "AWS/GCP/GitHub/OpenAI/Slack tokens" },
]

/** User-facing config shape. Read from `~/.config/sffmc/redact-secrets.yaml`. */
interface RedactionConfig {
  extraFilenameRules?: Array<{ id: string; pattern: string }>
  extraContentRules?: Array<{ id: string; pattern: string }>
  disabledRules?: string[]
}

const defaultConfig: RedactionConfig = {
  extraFilenameRules: [],
  extraContentRules: [],
  disabledRules: [],
}

/** Compiled rules cache. Populated lazily by `getCachedRulesSync()`. */
let compiledRules: ReadonlyArray<RedactionRule> | null = null

/** Test override for the config home dir (passed through to `loadConfig`). */
let _configHomeOverride: string | undefined

/**
 * Build the full rule list (user + builtins, with disables applied).
 * Async because `loadConfig` reads YAML from disk. Result is cached
 * per-process. Tests use `__resetRedactionCache()` to flush and
 * `__setRedactionConfigHome()` to redirect to a temp dir.
 */
async function getRules(): Promise<ReadonlyArray<RedactionRule>> {
  if (compiledRules !== null) return compiledRules
  const config = await loadConfig<RedactionConfig>("redact-secrets", defaultConfig, {
    configHome: _configHomeOverride,
  })
  const disabled = new Set(config.disabledRules ?? [])
  const userRules: RedactionRule[] = []
  for (const u of config.extraFilenameRules ?? []) {
    if (disabled.has(u.id)) continue
    try {
      userRules.push({ id: u.id as RedactionCategory, pattern: new RegExp(u.pattern, "i"), filenameOnly: true })
    } catch (e) {
      log.warn(`redact-secrets: invalid extraFilenameRules[${u.id}]:`, e)
    }
  }
  for (const u of config.extraContentRules ?? []) {
    if (disabled.has(u.id)) continue
    try {
      userRules.push({ id: u.id as RedactionCategory, pattern: new RegExp(u.pattern, "gi") })
    } catch (e) {
      log.warn(`redact-secrets: invalid extraContentRules[${u.id}]:`, e)
    }
  }
  // User rules run first so a user can override a built-in (e.g., redefine
  // `filename-token` with a tighter pattern).
  compiledRules = [
    ...userRules,
    ...BUILTIN_RULES.filter((r) => !disabled.has(r.id)),
  ]
  return compiledRules
}

/** Test escape hatch — flush the cache so the next call re-reads YAML. */
export function __resetRedactionCache(): void {
  compiledRules = null
}

/** Test escape hatch — point config loading at a temp dir. */
export function __setRedactionConfigHome(dir: string | undefined): void {
  _configHomeOverride = dir
  compiledRules = null
}

/** Ensure the rule cache is loaded. Plugin entry points call this from
 *  their `config` hook so the watcher hot-path is sync. */
export async function ensureRedactionRules(): Promise<void> {
  await getRules()
}

/**
 * Synchronous accessor. Returns the cached rules if available, otherwise
 * `BUILTIN_RULES` (the safe default — no user overrides applied). This is
 * the hot-path used by file watchers; after `ensureRedactionRules()` has
 * been awaited once, the cache is fully populated.
 */
function getCachedRulesSync(): ReadonlyArray<RedactionRule> {
  if (compiledRules !== null) return compiledRules
  return BUILTIN_RULES
}

/**
 * Return true if `filePath`'s basename matches a built-in or user-added
 * filename rule. Used by file watchers that skip indexing (L1: memory/watcher).
 *
 * Anchored to basename — `/api_keys.md` is caught, `/docs/api-keys.md` is
 * caught, `/docs/api-keys-overview.md` is caught (per rule), but
 * `/keys-overview.md` is not. The `private` rule is path-anchored to avoid
 * the false-positive documented in the v0.12.1 audit (L1 false positive:
 * `my-private-notes.md` was being filtered out).
 */
export function isSensitiveFilename(filePath: string): boolean {
  if (!filePath) return false
  const rules = getCachedRulesSync()
  const name = basename(filePath)
  return rules.some((r) => r.filenameOnly && r.pattern.test(name))
}

/**
 * Return true if `sourcePath` (full path or relative path) matches a built-in
 * or user-added source-path rule. Used by recon injection (L2: memory/recon).
 *
 * Matches against the full path — `/home/user/projects/credentials-checklist.md`
 * is caught. This is intentional: a recon entry whose source path itself
 * leaks credentials (e.g., `…/api-keys-2026.md`) is the leak, regardless of
 * the file's basename.
 */
export function isSensitiveSourcePath(sourcePath: string): boolean {
  if (!sourcePath) return false
  const rules = getCachedRulesSync()
  return rules.some((r) => !r.filenameOnly && r.pattern.test(sourcePath))
}

/**
 * Replace sensitive substrings in `content` with `[REDACTED:<category>]`.
 * Used by M5 (checkpoint write) and M6 (dream archive).
 *
 * Returns the original string with replacements applied in-place. The
 * replacement marker preserves the category so downstream tools (e.g., a
 * debugger inspecting the journal) can tell whether a token was an API
 * key vs a private key vs a password.
 */
export function redactSecrets(content: string): RedactionResult {
  if (!content) return { redacted: content, categories: [], count: 0 }
  const rules = getCachedRulesSync()
  let redacted = content
  const categories: RedactionCategory[] = []
  let count = 0
  for (const r of rules) {
    if (r.filenameOnly) continue
    const matches = redacted.match(r.pattern)
    if (!matches) continue
    categories.push(r.id)
    count += matches.length
    redacted = redacted.replace(r.pattern, `[REDACTED:${r.id}]`)
  }
  return { redacted, categories, count }
}
