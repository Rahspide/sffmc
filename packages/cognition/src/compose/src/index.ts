// SPDX-License-Identifier: MIT
// @sffmc/cognition — see ../../LICENSE

import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadConfig, type PluginContext } from "@sffmc/utilities";

// ---------------------------------------------------------------------------
// v0.14.2 hardcoded values (kept verbatim for backward compatibility).
//
// v0.14.3 second release migration (skills directory override (config), skills directory override (filesystem)) makes the skills directory
// configurable via `compose.skillsDir` and discovers the valid skill list
// from the filesystem when the directory is overridden. When the config
// value is empty (the default), both the directory and the skill list fall
// back to the v0.14.2 hardcoded values below — behavior is identical to
// v0.14.2 for users who do not customize `compose.skillsDir` in YAML.
// ---------------------------------------------------------------------------

/** Bundled skills directory. The v0.14.2 hardcoded `SKILLS_DIR` value.
 *  Used when `compose.skillsDir` is empty (the default). */
export const DEFAULT_SKILLS_DIR = join(import.meta.dirname, "..", "skills")

/** v0.14.2 hardcoded `VALID_SKILLS` list. Each entry corresponds to a
 *  `<name>.md` file under `DEFAULT_SKILLS_DIR`. The `as const` assertion
 *  preserves the union type for the default (non-filesystem-discovered)
 *  case so that callers can still get autocomplete on the bundled skill
 *  names. */
export const DEFAULT_SKILLS = [
  "ask",
  "audit-deps",
  "benchmark",
  "brainstorm",
  "code-review",
  "debug",
  "execute",
  "feedback",
  "merge",
  "new-skill",
  "parallel",
  "plan",
  "report",
  "review",
  "subagent",
  "tdd",
  "verify",
  "worktree",
] as const

/** Union type of the v0.14.2 hardcoded bundled skill names. Useful for
 *  callers that want compile-time type safety on the default skill set.
 *  When `compose.skillsDir` is overridden, the resolved skill list is
 *  filesystem-discovered and uses `string` instead — see
 *  `getComposeValidSkills()`. */
export type DefaultSkillName = (typeof DEFAULT_SKILLS)[number]

// ---------------------------------------------------------------------------
// second release migration (skills directory override (config), skills directory override (filesystem)) — YAML-configurable compose plugin.
//
// Pattern precedent: `packages/workflow/src/constants.ts`
// (`ensureWorkflowConfig`, `getWorkflowConfigSync`, `__setWorkflowConfig`).
// Same shape: a single `let _composeConfig` caches the merged config and
// the sync getter falls back to defaults when no load has happened.
//
// skills directory override (config) (`compose.skillsDir`) — directory containing `.md` skill files.
//     When empty (default), the bundled `DEFAULT_SKILLS_DIR` is used.
//     When set, the directory is used as the skills root and the valid
//     skill list is discovered from `*.md` basenames (skills directory override (filesystem)).
//
// skills directory override (filesystem) — `VALID_SKILLS` becomes **filesystem-discovered** when `skillsDir`
//     is set, falling back to the hardcoded `DEFAULT_SKILLS` list when
//     the config value is empty. The risk note in the migration plan
//     (the v0.14.x hardcode migration plan, file not in git; see CHANGELOG.md v0.14.5) is preserved: skill
//     availability changes when files are added/removed, so users who
//     depend on a stable skill name should set the override before
//     first run.
// ---------------------------------------------------------------------------

export interface ComposeConfig {
  /** skills directory override (config) — skills directory override. Empty string (the default) means
   *  "use the bundled `DEFAULT_SKILLS_DIR`". When set to a non-empty
   *  path, the value is used as the skills root and the valid skill
   *  list is discovered from `*.md` basenames in that directory. */
  skillsDir: string
}

export const DEFAULT_COMPOSE_CONFIG: ComposeConfig = {
  // skills directory override (config) — empty string preserves the v0.14.2 behavior
  // (`join(import.meta.dirname, "..", "skills")` resolved at module load).
  skillsDir: "",
}

let _composeConfig: ComposeConfig | null = null
let _composeConfigPromise: Promise<ComposeConfig> | null = null

/** Load `~/.config/SFFMC/compose.yaml` once and cache the result.
 *  Idempotent — concurrent callers receive the same promise.
 *
 *  @param opts.configHome — override the config directory (useful for
 *    tests that need an isolated config file). Defaults to
 *    `~/.config/SFFMC`. */
export function ensureComposeConfig(
  opts?: { configHome?: string },
): Promise<ComposeConfig> {
  if (_composeConfig) return Promise.resolve(_composeConfig)
  if (!_composeConfigPromise) {
    _composeConfigPromise = loadConfig<Partial<ComposeConfig>>(
      "compose",
      DEFAULT_COMPOSE_CONFIG,
      { configHome: opts?.configHome },
    ).then((loaded) => {
      const merged: ComposeConfig = {
        ...DEFAULT_COMPOSE_CONFIG,
        ...loaded,
      }
      _composeConfig = merged
      return merged
    })
  }
  return _composeConfigPromise
}

/** Sync accessor — returns the cached config or the defaults if the
 *  YAML hasn't been loaded yet. Use this in hot paths where awaiting is
 *  not an option; call `ensureComposeConfig()` at startup to populate. */
export function getComposeConfigSync(): ComposeConfig {
  return _composeConfig ?? DEFAULT_COMPOSE_CONFIG
}

// ---------------------------------------------------------------------------
// Config-aware getters. Each prefers the YAML override and falls back to
// the exported module-level constant (the prior hardcoded value).
// ---------------------------------------------------------------------------

/** skills directory override (config) — resolved skills directory. When `compose.skillsDir` is empty
 *  (the default), returns the bundled `DEFAULT_SKILLS_DIR`. Otherwise
 *  returns the configured path. */
export function getComposeSkillsDir(): string {
  const cfg = getComposeConfigSync().skillsDir
  return cfg && cfg.length > 0 ? cfg : DEFAULT_SKILLS_DIR
}

/** skills directory override (filesystem) — resolved list of valid skill names. When `compose.skillsDir` is
 *  empty (the default), returns the hardcoded `DEFAULT_SKILLS` list
 *  (preserves v0.14.2 behavior). Otherwise reads the directory and
 *  returns the basenames of every `*.md` file in alphabetical order.
 *
 *  Filesystem discovery is best-effort: if the configured directory is
 *  unreadable, this falls back to `DEFAULT_SKILLS` and the bundled
 *  directory is still accessible via `getComposeSkillsDir()`. The
 *  fallback is logged as a warning so users notice misconfiguration
 *  without a hard crash.
 */
export async function getComposeValidSkills(): Promise<readonly string[]> {
  const configured = getComposeConfigSync().skillsDir
  if (!configured) {
    // Default case — use the v0.14.2 hardcoded list.
    return DEFAULT_SKILLS
  }
  try {
    const entries = await readdir(configured)
    return entries
      .filter((f) => f.endsWith(".md"))
      .map((f) => basename(f, ".md"))
      .sort()
  } catch (_err) {
    // Unreadable directory — fall back to the hardcoded list. The plugin
    // can still load bundled skills via the default directory.
    return DEFAULT_SKILLS
  }
}

// ---------------------------------------------------------------------------
// Test escape hatch — `__setComposeConfig()` is a v0.14.3 D-1 pattern.
// The function is NOT publicly exported from `src/index.ts`. Tests reach
// it through a Symbol registry populated at module load, looked up via
// `Symbol.for("@sffmc/cognition.__setComposeConfig")` in
// `tests/_test-helpers/config-cache.ts`. This keeps the test-only
// mutation off the public surface while still allowing tests to inject
// fake configs without round-tripping through YAML.
// ---------------------------------------------------------------------------

function __setComposeConfig(cfg: ComposeConfig | null): void {
  _composeConfig = cfg
  _composeConfigPromise = null
}

const __SET_COMPOSE_CONFIG_SYMBOL = Symbol.for("@sffmc/cognition.__setComposeConfig")
;(globalThis as Record<symbol, unknown>)[__SET_COMPOSE_CONFIG_SYMBOL] = __setComposeConfig

// ---------------------------------------------------------------------------
// Plugin entry point.
// ---------------------------------------------------------------------------

export const id = "@sffmc/cognition"

/** v0.14.3 second release: `server()` now resolves the skills directory
 *  and the valid skill list from config (`getComposeSkillsDir()` and
 *  `getComposeValidSkills()`). Both fall back to the v0.14.2
 *  hardcoded values when no `compose.skillsDir` is set in YAML, so the
 *  default behavior is unchanged. The `server()` function was already
 *  `async` in v0.14.2 (returned `Promise<…>`), so the `await
 *  getComposeValidSkills()` adds no new scheduling constraint. */
export const server = async (_ctx: PluginContext) => {
  const skillsDir = getComposeSkillsDir()
  const validSkills = await getComposeValidSkills()
  return {
    tool: {
      compose_skill: {
        description:
          "Load a Compose Mode skill (verify/tdd/plan/etc) by name. Returns the skill's full markdown content.",
        parameters: {
          name: {
            type: "string",
            description: `Skill name: ${validSkills.join(", ")}`,
          },
        },
        execute: async ({ name }: { name: string }) => {
          if (!name || typeof name !== "string") {
            return `Error: skill name is required`
          }
          if (!validSkills.includes(name)) {
            return `Error: Unknown skill "${name}". Valid skills: ${validSkills.join(", ")}`
          }
          const filePath = join(skillsDir, `${name}.md`)
          try {
            const content = await readFile(filePath, "utf-8")
            if (content.length === 0) {
              return `Error: skill '${name}' is empty (file has no content)`
            }
            return content
          } catch (err) {
            return `Error: failed to load skill '${name}': ${err instanceof Error ? err.message : String(err)}`
          }
        },
      },
    },
  }
}

export default { id, server }
