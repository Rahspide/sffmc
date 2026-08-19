import { resolve as resolvePath } from "node:path";
import { compileRules, type CompiledRule, type Rules } from "./rules";
import { normalizeCommand } from "./normalize";
import { anchoredTest } from "./compileRules";

/** Tool-call arguments relevant to the safety gate. Only the keys the
 *  gate actually inspects (command for `bash`, file paths for
 *  `path_outside` checks) are typed; other tool-specific fields are
 *  not part of the gate's contract. */
export interface ToolArgs {
  command?: string;
  filePath?: string;
  path?: string;
  paths?: string[] | string;
  from?: string;
  to?: string;
  workdir?: string;
}

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
  args: ToolArgs | undefined,
  projectRoot: string,
) {
  try {
    // Two-phase matching (v0.15.2 § 1):
    //
    //   raw        — the command exactly as received. Rules flagged
    //                `phase: raw` are obfuscation heuristics: they must
    //                see the ORIGINAL encoding (ANSI vs NUL bytes vs
    //                fullwidth forms) because normalization erases the
    //                difference by design. Raw rules anchor on the raw
    //                string with substitution recursion disabled — the
    //                same shape inside `$(…)` is usually inert data.
    //   normalized — the command after `normalizeCommand()` (NFKC,
    //                null strip, line-continuation join, ANSI/OSC
    //                strip). The default phase: these rules care about
    //                WHAT the shell will execute.
    //
    // Mutating fresh locals (not the caller's object) keeps the API
    // total without side effects on the caller's args.
    const isBash = toolName === "bash" && typeof args?.command === "string";
    const rawCommand = isBash ? (args!.command as string) : null;
    const normalizedArgs = isBash
      ? { ...args, command: normalizeCommand(rawCommand!) }
      : args;

    const compiled: CompiledRule[] = isRules(rulesInput)
      ? compileRules(rulesInput).rules
      : rulesInput;

    for (const rule of compiled) {
      if (rule.match.tool !== toolName) continue;

      if (rule.commandMatch) {
        if (isBash) {
          const phase = rule.commandMatch.phase ?? "normalized";
          if (phase === "raw") {
            if (
              anchoredTest(rawCommand!, rule.commandMatch.regex, {
                excludeSubstitutions: true,
              })
            ) {
              return {
                action: rule.action,
                reason: `command matches "${rule.commandMatch.source}" (raw phase)`,
              };
            }
          } else if (
            anchoredTest(
              normalizedArgs!.command as string,
              rule.commandMatch.regex,
            )
          ) {
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

function extractPaths(args: ToolArgs | undefined): string[] {
  const paths: string[] = [];
  if (!args || typeof args !== "object") return paths;

  const pathKeys: (keyof ToolArgs)[] = ["filePath", "path", "paths", "from", "to", "workdir"];
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
