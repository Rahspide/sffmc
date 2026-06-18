import { parse as parseYaml } from "yaml";
import { readFileSync, existsSync, statSync } from "fs";

export type Action = "allow" | "deny" | "ask";

const VALID_ACTIONS = new Set<Action>(["allow", "deny", "ask"]);

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

let panicMode = false;

export function isPanicMode(): boolean {
  return panicMode;
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
    const parsed = parseYaml(yaml) as Record<string, unknown>;
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
