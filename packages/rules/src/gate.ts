import type { Rules, Action } from "./rules";

export function evaluate(
  rules: Rules,
  toolName: string,
  args: Record<string, unknown> | undefined,
  projectRoot: string,
): { action: Action; reason: string } {
  for (const rule of rules.rules) {
    if (rule.match.tool !== toolName) continue;

    if (rule.match.command_match) {
      if (toolName === "bash" && typeof args?.command === "string") {
        const regex = new RegExp(rule.match.command_match);
        if (regex.test(args.command)) {
          return {
            action: rule.action,
            reason: `command matches "${rule.match.command_match}"`,
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
  // treated as "inside" (line 67 fallback) and the path_outside check
  // never fires, bypassing the safety gate.
  const resolved = target.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(target)
    ? target
    : resolvePath(root, target);
  const normalized = resolved.replace(/\\/g, "/");
  const normalizedRoot = root.replace(/\\/g, "/");
  const rootWithSep = normalizedRoot.endsWith("/") ? normalizedRoot : normalizedRoot + "/";
  return normalized === normalizedRoot || normalized.startsWith(rootWithSep);
}

// Tiny resolvePath to avoid importing node:path (keeps module dependency-free
// for browser/runtime-agnostic use). Handles "../" and "./" segments.
function resolvePath(root: string, rel: string): string {
  const stack: string[] = [];
  const rootParts = root.replace(/\\/g, "/").split("/");
  for (const p of rootParts) {
    if (p === "" || p === ".") continue;
    stack.push(p);
  }
  const relParts = rel.replace(/\\/g, "/").split("/");
  for (const p of relParts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      if (stack.length > 0) stack.pop();
      continue;
    }
    stack.push(p);
  }
  const prefix = root.startsWith("/") ? "/" : /^[a-zA-Z]:/.test(root) ? "" : "/";
  return prefix + stack.join("/");
}
