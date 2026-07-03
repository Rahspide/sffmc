#!/usr/bin/env python3
"""Audit SFFMC plugin hooks and detect conflicts - v2.

Key insight: find the server = async (...) => { ... } block first, then
find the return { ... } inside it.
"""

import os
import re
import json

# Derive PKG_LIST from root package.json workspaces (single source of truth).
# workspaces is ["packages/*", "shared"]; "packages/*" expands to the immediate
# subdirectories of packages/ (stored as "packages/<dir>"), "shared" is stored
# literally. Each entry is a workspace-relative path so the same list works for
# both globs and bare directory names. Asserting the count guards against
# silent drift if a future workspace pattern is added without updating here.
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with open(os.path.join(_REPO_ROOT, "package.json")) as _f:
    _WORKSPACES = json.load(_f)["workspaces"]

PKG_LIST = []
for _ws in _WORKSPACES:
    if _ws.endswith("/*"):
        _parent = _ws[:-2]
        _pkg_root = os.path.join(_REPO_ROOT, _parent)
        PKG_LIST.extend(sorted(
            f"{_parent}/{d}" for d in os.listdir(_pkg_root)
            if os.path.isdir(os.path.join(_pkg_root, d))
            and not d.startswith(".")
        ))
    else:
        PKG_LIST.append(_ws)

assert len(PKG_LIST) == 5, f"PKG_LIST drift: got {len(PKG_LIST)}, expected 5 ({PKG_LIST})"


# Real OpenCode hook keys
KNOWN_HOOKS = {
    'config', 'event', 'permission', 'tool',
    'chat.message', 'chat.params', 'chat.system',
    'tool.execute.before', 'tool.execute.after',
    'command.execute.before', 'command.execute.after',
    'permission.ask', 'permission.respond',
    'experimental.text.complete', 'experimental.chat.system.transform',
    'experimental.chat.messages.transform', 'experimental.chat.params',
    'auth', 'headers', 'provider',
}

# TypeScript / common false-positive keys (function param names that look like keys)
FALSE_POSITIVES = {
    'async', 'function', 'return', 'if', 'for', 'while', 'const', 'let', 'var',
    'else', 'do', 'switch', 'case', 'break', 'continue', 'default', 'try',
    'catch', 'finally', 'throw', 'new', 'typeof', 'instanceof', 'in', 'of',
    'class', 'interface', 'type', 'enum', 'export', 'import', 'from', 'as',
    'public', 'private', 'protected', 'static', 'readonly', 'abstract',
    'true', 'false', 'null', 'undefined', 'void', 'never', 'unknown', 'any',
    'this', 'super', 'args', 'kwargs', 'params',
}


def find_server_function(content: str) -> tuple[int, int] | None:
    """Find the server = async (...) => { ... } function body.
    Supports both forms:
      const server = async (ctx) => { ... }
      export default { id: "...", server: async (ctx) => { ... }, ... }
    """
    patterns = [
        r'\bserver\s*=\s*async\s*\([^)]*\)\s*=>\s*\{',
        r'\bserver\s*=\s*\([^)]*\)\s*=>\s*\{',
        # Property form: server: async (...) => {
        r'\bserver\s*:\s*async\s*\([^)]*\)\s*=>\s*\{',
    ]
    for pat in patterns:
        m = re.search(pat, content)
        if m:
            start = m.end()
            depth = 1
            pos = start
            in_str = None
            in_comment = None
            while pos < len(content) and depth > 0:
                c = content[pos]
                if in_str:
                    if c == '\\':
                        pos += 2
                        continue
                    if c == in_str:
                        in_str = None
                elif in_comment:
                    if c == '\n':
                        in_comment = None
                else:
                    if c in ('"', "'", '`'):
                        in_str = c
                    elif c == '/' and pos + 1 < len(content) and content[pos+1] == '/':
                        in_comment = True
                    elif c == '{':
                        depth += 1
                    elif c == '}':
                        depth -= 1
                pos += 1
            return (start, pos - 1)
    return None


def find_return_in_server(content: str, server_range: tuple[int, int]) -> tuple[int, int] | None:
    """Find the LAST return { ... } block within the server function body."""
    start, end = server_range
    body = content[start:end]
    # Find all 'return {' in body
    returns = list(re.finditer(r'\breturn\s*\{', body))
    if not returns:
        return None
    # Use the LAST one (the outermost server return)
    m = returns[-1]
    abs_start = start + m.end()
    depth = 1
    pos = abs_start
    in_str = None
    while pos < len(content) and depth > 0:
        c = content[pos]
        if in_str:
            if c == '\\':
                pos += 2
                continue
            if c == in_str:
                in_str = None
        else:
            if c in ('"', "'", '`'):
                in_str = c
            elif c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
        pos += 1
    return (abs_start, pos - 1)


def extract_hook_keys(content: str) -> list[str]:
    """Extract top-level hook keys from server() return block."""
    server_range = find_server_function(content)
    if not server_range:
        return []
    return_range = find_return_in_server(content, server_range)
    if not return_range:
        return []
    start, end = return_range
    block = content[start:end]

    # Detect the canonical indent: find the first non-blank, non-comment, non-'}' line
    canonical_indent = None
    for line in block.split('\n'):
        if not line.strip() or line.strip().startswith('//'):
            continue
        if line.lstrip().startswith('}'):
            continue
        # Get leading spaces
        stripped = line.lstrip()
        indent = len(line) - len(stripped)
        if indent > 0:
            canonical_indent = indent
            break
    if canonical_indent is None:
        return []

    keys = []
    seen = set()
    for line in block.split('\n'):
        if not line.strip() or line.strip().startswith('//'):
            continue
        if line.lstrip().startswith('}'):
            continue
        # Match: canonical indent, optional quote, identifier, optional quote, colon
        pattern = r'^( {' + str(canonical_indent) + r'})("?)([\w][\w.\-]*)(\2)\s*:\s*'
        m = re.match(pattern, line)
        if m:
            key = m.group(3)
            if key in FALSE_POSITIVES:
                continue
            if key in seen:
                continue
            seen.add(key)
            keys.append(key)
    return keys


def main():
    all_hooks = {}
    pkg_hooks = {}

    print('=== Hook keys per SFFMC plugin ===\n')
    for pkg in PKG_LIST:
        # pkg is a workspace-relative path (e.g. "packages/memory" or "shared");
        # use the leaf name for display and conflict aggregation.
        pkg_name = os.path.basename(pkg)
        path = os.path.join(_REPO_ROOT, pkg, 'src', 'index.ts')
        if not os.path.exists(path):
            print(f'@sffmc/{pkg_name}: NOT FOUND')
            continue
        with open(path) as f:
            content = f.read()
        keys = extract_hook_keys(content)
        pkg_hooks[pkg_name] = keys
        print(f'@sffmc/{pkg_name}:')
        for k in keys:
            print(f'  - {k}')
            all_hooks.setdefault(k, []).append(pkg_name)
        if not keys:
            print('  (no hooks found)')
        print()

    print('=== Hook conflict analysis ===\n')
    conflicts = 0
    expected_multi = {'tool'}  # multiple plugins can register tools under 'tool' key
    for hook, pkgs in all_hooks.items():
        if hook in expected_multi:
            print(f'  • "{hook}" — {len(pkgs)} plugins: {pkgs} (expected: each registers distinct tool name)')
            continue
        if len(pkgs) > 1:
            conflicts += 1
            print(f'  ⚠ CONFLICT: "{hook}" registered by {pkgs}')
    if conflicts == 0:
        print('  ✓ no SFFMC-internal hook conflicts')

    print('\n=== Hook role categorization ===\n')
    role = {}
    for hook, pkgs in all_hooks.items():
        if hook == 'tool' or hook in ('compose_skill', 'workflow'):
            role.setdefault('tool-registration', []).extend(pkgs)
        elif 'before' in hook or 'permission' in hook:
            role.setdefault('pre-execution-gate', []).extend(pkgs)
        elif 'after' in hook or hook == 'event':
            role.setdefault('post-execution', []).extend(pkgs)
        elif 'transform' in hook or hook == 'config':
            role.setdefault('transform-config', []).extend(pkgs)
        elif 'text.complete' in hook:
            role.setdefault('output-filter', []).extend(pkgs)
        else:
            role.setdefault('other', []).extend(pkgs)
    for r, ps in role.items():
        unique = sorted(set(ps))
        print(f'  {r}: {unique}')

    # Save report
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".sffmc", "load-order-audit.json")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    report = {
        'pkg_hooks': pkg_hooks,
        'all_hooks': all_hooks,
        'role': role,
        'conflicts': conflicts,
    }
    with open(output_path, 'w') as f:
        json.dump(report, f, indent=2)
    print(f'\n→ saved to {output_path}')


if __name__ == '__main__':
    main()
