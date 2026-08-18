import { parse as parseYaml, Schema } from "yaml";
import { readFileSync, existsSync, statSync } from "fs";
import safeRegex from "safe-regex";
import { createLogger, SAFE_REPETITION_LIMIT } from "@sffmc/utilities";

const log = createLogger("rules");

export type Action = "allow" | "deny" | "ask";

const VALID_ACTIONS = new Set<Action>(["allow", "deny", "ask"]);

// ReDoS guard for `command_match` patterns. Mirrors the redact-secrets
// approach (star-height ≤ 1, repetition limit 25 — sourced from
// `@sffmc/utilities/SAFE_REPETITION_LIMIT` for a single source of truth).
// A `false` return from `safe-regex` means the pattern is potentially
// catastrophic and must not be compiled (or evaluated against
// attacker-controlled bash input).

export interface RuleMatch {
  tool: string;
  command_match?: string;
  path_outside?: string;
  /**
   * Which form of the bash command this rule is tested against.
   *
   * - `normalized` (default): the command after `normalizeCommand()` —
   *   NFKC-folded, ANSI/null/line-continuation stripped. Use this when
   *   the rule cares about WHAT the shell will execute.
   * - `raw`: the command exactly as received. Use this when the rule
   *   cares about HOW the payload was encoded — e.g. distinguishing an
   *   ANSI-obfuscated `printf` (deny) from a NUL-obfuscated one (ask),
   *   which normalization erases by design.
   *
   * Raw-phase rules are still anchored (`anchoredTest`) on the raw
   * string, so obfuscation hidden in an argument does not fire them.
   */
  phase?: "raw" | "normalized";
}

export interface Rule {
  match: RuleMatch;
  action: Action;
}

export interface Rules {
  version: number;
  rules: Rule[];
}

/**
 * Rule with its regex pre-compiled. Built once at rule-load time by
 * `compileRules()` and reused on every tool-call evaluation — avoids the
 * per-call cost of `new RegExp(...)` and, more importantly, ensures unsafe
 * patterns never reach `regex.test()` (which would allow ReDoS via user YAML).
 */
export interface CompiledRule {
  match: RuleMatch;
  action: Action;
  commandMatch?: {
    /** Original pattern string from YAML — used in the `reason` message. */
    source: string;
    regex: RegExp;
    /** Matching phase — mirrored from `RuleMatch.phase` (default normalized). */
    phase?: "raw" | "normalized";
  };
}

/**
 * Pre-compile all rules. Patterns flagged as ReDoS-unsafe by `safe-regex`
 * (which also rejects patterns that fail to compile — its analyzer runs
 * `new RegExp` internally) are dropped with a warning. Returns the safe
 * subset plus the list of skipped entries so callers can surface them in
 * logs / health checks.
 */
export function compileRules(rawRules: Rules): {
  rules: CompiledRule[];
  errors: string[];
} {
  const rules: CompiledRule[] = [];
  const errors: string[] = [];
  for (const rule of rawRules.rules) {
    if (!rule.match.command_match) {
      rules.push({ match: rule.match, action: rule.action });
      continue;
    }
    const patternSource = rule.match.command_match;
    if (!safeRegex(patternSource, { limit: SAFE_REPETITION_LIMIT })) {
      const msg = `unsafe command_match (ReDoS) — rule skipped: /${patternSource}/`;
      log.warn(msg);
      errors.push(msg);
      continue;
    }
    rules.push({
      match: rule.match,
      action: rule.action,
      commandMatch: {
        source: patternSource,
        regex: new RegExp(patternSource),
        phase: rule.match.phase === "raw" ? "raw" : "normalized",
      },
    });
  }
  return { rules, errors };
}

/** Shared mutable state — violates DLC "no shared state" contract.
 *  Consider refactoring to a RulesManager class in a future PR. */
let panicMode = false;

export function isPanicMode(): boolean {
  return panicMode;
}

/** Reset panic mode. Useful for tests and after manual rules reload. */
export function resetPanicMode(): void {
  panicMode = false;
}

export function loadRules(path: string): Rules {
  if (!existsSync(path)) {
    return { version: 1, rules: [] };
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return parseRules(raw);
  } catch (e) {
    log.warn({ err: e, path }, "rules: loadRules failed — entering panic mode")
    panicMode = true;
    return { version: 1, rules: [] };
  }
}

export function watchRules(
  path: string,
  onChange: (rules: Rules) => void,
): { stop: () => void } {
  let lastMtime = existsSync(path) ? statSync(path).mtimeMs : 0;

  const interval = setInterval(() => {
    if (!existsSync(path)) return;
    const mtime = statSync(path).mtimeMs;
    if (mtime > lastMtime) {
      lastMtime = mtime;
      try {
        const rules = loadRules(path);
        panicMode = false;
        onChange(rules);
      } catch (e) {
        log.warn({ err: e, path }, "rules: watchRules reload failed — entering panic mode")
        panicMode = true;
        onChange({ version: 1, rules: [] });
      }
    }
  }, 1000);

  return { stop: () => clearInterval(interval) };
}

export function parseRules(yaml: string): Rules {
  try {
    // SAFETY: validated by yaml parser schema on line 161 — Schema.JSON enforces object shape
    const parsed = parseYaml(yaml, { schema: Schema.JSON }) as Record<string, unknown>;
    if (!parsed || !Array.isArray(parsed.rules)) {
      throw new Error('Invalid rules format: missing "rules" array');
    }

    // SAFETY: narrowed by Array.isArray on line 162 — parsed.rules is guaranteed to be an array
    for (const rule of parsed.rules as Rule[]) {
      if (!rule.match || typeof rule.match.tool !== "string") {
        throw new Error(`Invalid rule: missing match.tool`);
      }
      if (!VALID_ACTIONS.has(rule.action)) {
        throw new Error(
          `Invalid action "${rule.action}" in rule — must be allow, deny, or ask`,
        );
      }
    }

    panicMode = false;
    // SAFETY: validated by rule loop on lines 166-177 — each rule has match.tool and valid action
    return parsed as unknown as Rules;
  } catch (err) {
    panicMode = true;
    throw err;
  }
}
