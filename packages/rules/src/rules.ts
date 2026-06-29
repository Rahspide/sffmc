import { parse as parseYaml, Schema } from "yaml";
import { readFileSync, existsSync, statSync } from "fs";
import safeRegex from "safe-regex";
import { createLogger } from "@sffmc/shared";

const log = createLogger("rules");

export type Action = "allow" | "deny" | "ask";

const VALID_ACTIONS = new Set<Action>(["allow", "deny", "ask"]);

// ReDoS guard for `command_match` patterns. Mirrors the redact-secrets
// approach (star-height ≤ 1, repetition limit 25) — a `false` return from
// `safe-regex` means the pattern is potentially catastrophic and must not be
// compiled (or evaluated against attacker-controlled bash input).
const SAFE_REGEX_LIMIT = 25;

export interface RuleMatch {
  tool: string;
  command_match?: string;
  path_outside?: string;
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
    if (!safeRegex(patternSource, { limit: SAFE_REGEX_LIMIT })) {
      const msg = `unsafe command_match (ReDoS) — rule skipped: /${patternSource}/`;
      log.warn(msg);
      errors.push(msg);
      continue;
    }
    rules.push({
      match: rule.match,
      action: rule.action,
      commandMatch: { source: patternSource, regex: new RegExp(patternSource) },
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
  } catch {
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
      } catch {
        panicMode = true;
        onChange({ version: 1, rules: [] });
      }
    }
  }, 1000);

  return { stop: () => clearInterval(interval) };
}

export function parseRules(yaml: string): Rules {
  try {
    const parsed = parseYaml(yaml, { schema: Schema.JSON }) as Record<string, unknown>;
    if (!parsed || !Array.isArray(parsed.rules)) {
      throw new Error('Invalid rules format: missing "rules" array');
    }

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
    return parsed as unknown as Rules;
  } catch (err) {
    panicMode = true;
    throw err;
  }
}
