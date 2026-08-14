import { resolve as resolvePath } from "node:path";
import { compileRules, type CompiledRule, type Rules, type Action } from "./rules";
import { normalizeCommand } from "./normalize";
import { anchoredTest } from "./compileRules";

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
 *
 * v0.15.2 hardening:
 *   - For `bash` tool calls, the raw command is normalized (NFKC, null
 *     strip, line-continuation join, ANSI/OSC strip) before matching,
 *     so obfuscations like `ｒｍ`, ANSI-colored payloads, or shell line
 *     continuations cannot bypass detection.
 *   - `command_match` patterns are tested with `anchoredTest` instead
 *     of raw `regex.test`, so a dangerous substring that only appears
 *     inside an argument (`git commit -m "rm -rf /"`) is not mistaken
 *     for a real command.
 *   - Any throw inside the body (catastrophic regex, type error in a
 *     custom rule, etc.) is caught and converted to a `deny` verdict —
 *     fail-closed. The v0.15.2 § 3 acceptance criterion: detection error ⇒
 *     deny, never silently allow.
 */
export function evaluate(
  rulesInput: CompiledRule[] | Rules,
  toolName: string,
  args: Record<string, unknown> | undefined,
  projectRoot: string,
): { action: Action; reason: string } {
  try {
    // Normalize the bash command at entry — strips ANSI/NFKC/null/
    // line-continuation before any rule sees it. Mutating a fresh
    // local (not the caller's object) keeps the API total without
    // side effects on the caller's args.
    let normalizedArgs = args;
    if (toolName === "bash" && typeof args?.command === "string") {
      normalizedArgs = { ...args, command: normalizeCommand(args.command) };
    }

    const compiled: CompiledRule[] = isRules(rulesInput)
      ? compileRules(rulesInput).rules
      : rulesInput;

    for (const rule of compiled) {
      if (rule.match.tool !== toolName) continue;

      if (rule.commandMatch) {
        if (toolName === "bash" && typeof normalizedArgs?.command === "string") {
          if (anchoredTest(normalizedArgs.command, rule.commandMatch.regex)) {
            return {
              action: rule.action,
              reason: `command matches "${rule.commandMatch.source}"`,
            };
          }
        }
        continue;
      }

      if (rule.match.path_outside) {
        const candidatePaths = extractPaths(normalizedArgs);
        const anyOutside = candidatePaths.some((p) => !isInside(projectRoot, p));
        if (anyOutside) {
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
  } catch (err) {
    // Fail-closed: any throw inside the gate (regex.exec on a
    // pathological pattern, type errors in a custom CompiledRule,
    // JSON.parse in a plugin handler that wraps us, …) becomes a
    // deny. Silently allowing on error would be a security regression.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      action: "deny",
      reason: `gate_failure: ${msg}`,
    };
  }
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
  for (const pathKey of pathKeys) {
    const argValue = args[pathKey];
    if (typeof argValue === "string") paths.push(argValue);
    if (Array.isArray(argValue)) {
      for (const pathItem of argValue) {
        if (typeof pathItem === "string") paths.push(pathItem);
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
