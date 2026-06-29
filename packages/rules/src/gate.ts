import { resolve as resolvePath } from "node:path";
import { compileRules, type CompiledRule, type Rules, type Action } from "./rules";

/**
 * Evaluate a tool call against the rule list. Accepts either:
 *   - a pre-compiled list (`CompiledRule[]`) — the hot path, produced by
 *     `compileRules()` at rule-load time. Regex objects are reused, unsafe
 *     patterns have already been filtered out.
 *   - a raw `Rules` object — auto-compiled on each call (legacy shape, kept
 *     for callers that haven't migrated). The auto-compile step still runs
 *     the ReDoS guard so the legacy path is not a regression.
 *
 * Detect by shape: `Rules` has a top-level `rules: Rule[]` array; a
 * pre-compiled list does not.
 */
export function evaluate(
  rulesOrCompiled: CompiledRule[] | Rules,
  toolName: string,
  args: Record<string, unknown> | undefined,
  projectRoot: string,
): { action: Action; reason: string } {
  const compiled: CompiledRule[] = isRules(rulesOrCompiled)
    ? compileRules(rulesOrCompiled).rules
    : rulesOrCompiled;

  for (const rule of compiled) {
    if (rule.match.tool !== toolName) continue;

    if (rule.commandMatch) {
      if (toolName === "bash" && typeof args?.command === "string") {
        if (rule.commandMatch.regex.test(args.command)) {
          return {
            action: rule.action,
            reason: `command matches "${rule.commandMatch.source}"`,
          };
        }
      }
      continue;
    }

    if (rule.match.path_outside) {
      const paths = extractPaths(args);
      const outside = paths.some((p) => !isInside(projectRoot, p));
      if (outside) {
        return {
          action: rule.action,
          reason: `path outside ${rule.match.path_outside} (${projectRoot})`,
        };
      }
      continue;
    }

    return {
      action: rule.action,
      reason: `tool matches "${toolName}"`,
    };
  }

  return { action: "allow", reason: "no matching rule" };
}

function isRules(input: CompiledRule[] | Rules): input is Rules {
  // `Rules` is `{ version, rules: Rule[] }`; `CompiledRule[]` is a bare
  // array. The discriminator is the presence of the `rules` property.
  return !Array.isArray(input) && typeof input === "object" && "rules" in input;
}

function extractPaths(args: Record<string, unknown> | undefined): string[] {
  const paths: string[] = [];
  if (!args || typeof args !== "object") return paths;

  const pathKeys = ["filePath", "path", "paths", "from", "to", "workdir"];
  for (const key of pathKeys) {
    const val = args[key];
    if (typeof val === "string") paths.push(val);
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === "string") paths.push(item);
      }
    }
  }
  return paths;
}

function isInside(root: string, target: string): boolean {
  // Resolve relative paths against root — otherwise "../etc/passwd" is
  // treated as "inside" (line below) and the path_outside check
  // never fires, bypassing the safety gate.
  const resolved = resolvePath(root, target);
  const normalized = resolved.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  const rootWithSep = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
  return normalized === normalizedRoot || normalized.startsWith(rootWithSep);
}
