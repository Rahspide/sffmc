# Contributing to SFFMC

SFFMC is a monorepo of standalone OpenCode plugins. Each plugin:
- Lives in its own directory under `packages/`
- Exports a default `{ id, server }` from `src/index.ts`
- Has its own README, tests (`src/index.test.ts` or `tests/`), and changelog entry in root `CHANGELOG.md`
- Uses Bun as the runtime (Bun 1.3+, JavaScriptCore engine)
- Targets OpenCode 1.17.x plugin SDK (and tracks upstream changes)

## Architecture: DLC (Drop-in Lattice Components)

Every SFFMC plugin follows the **DLC** pattern:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means you can `rm -rf packages/foo && bun test` and nothing else should break.

## Adding a new plugin

```bash
mkdir -p packages/my-feature
cd packages/my-feature
cat > package.json <<'EOF'
{
  "name": "@sffmc/my-feature",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test", "build": "tsc --noEmit" },
  "license": "MIT"
}
EOF
mkdir src
```

`src/index.ts` skeleton:
```ts
// SPDX-License-Identifier: MIT
// @sffmc/my-feature — see ../../LICENSE

import type { PluginContext } from "@sffmc/shared"  // or your own interface

export default {
  id: "@sffmc/my-feature",
  server: async (ctx: PluginContext) => {
    return {
      config: async (_cfg: unknown) => { /* startup */ },
      "tool.execute.before": async (toolCtx, args) => { /* gate */ },
      // ... other hooks
    }
  },
}
```

Then add tests, README, and register in `~/.config/opencode/opencode.json` (or sandbox config) `plugin[]`.

## Local testing

```bash
# Run all plugin tests (SFFMC scope only, ignores dependencies/)
bun test

# Watch mode — re-runs tests on every .ts save (Bun's built-in)
bun run test:watch

# Run one package
cd packages/workflow && bun test

# Type-check (uses bun build --no-bundle, no global tsc needed)
bun run typecheck

# Build all to /tmp/sffmc-build
bun run build

# Audit hook conflicts (must pass before commit)
python3 scripts/audit-load-order.py
```

### Pre-commit hook

The pre-commit hook is already configured in `.git/hooks/pre-commit`.

The hook runs automatically before every commit:
1. `bun test` (must pass)
2. `bun run typecheck` (must pass)
3. `python3 scripts/audit-load-order.py` (must show 0 conflicts)

Bypass with `git commit --no-verify` (use sparingly — CI will catch it later if remote is set up).

## Testing plugin changes locally

1. Edit your plugin files under `packages/<plugin>/src/`
2. Run `bun test` to verify your changes don't break anything
3. Restart your OpenCode instance to pick up the new plugin code
4. Check the OpenCode status/logs for any load errors

## Committing

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`
- One commit per logical change; one commit per tag (release commits batch the changelog)
- All commits must have working tests at HEAD
- Tag with `git tag -a v0.x.y` after a release commit

## Adding to root CHANGELOG

```md
## v0.X.Y — Short title (YYYY-MM-DD)

- @sffmc/my-feature (W#) — one-line description
- Other change
```

## Plugin SDK quick reference

| Hook | Use for |
|---|---|
| `config` | one-time startup work (load files, init DB) |
| `event` | react to OpenCode events (session.created, etc.) |
| `tool.execute.before` | gate or modify a tool call BEFORE it runs |
| `tool.execute.after` | inspect or modify a tool's output AFTER it runs |
| `experimental.chat.system.transform` | inject content into the LLM's system prompt |
| `experimental.chat.messages.transform` | mutate the message array before the next LLM call |
| `experimental.text.complete` | filter streaming text completions (EOS strip, etc.) |
| `command.execute.before` | intercept slash commands (e.g. `/max`) |
| `permission.ask` | replace OpenCode's permission prompt with your own |
| `tool` | register a new LLM-callable tool (key = tool name) |

**OpenCode 1.17.x gotcha**: the `tool` hook's **key** is the tool's name, NOT a `name` field inside the tool definition. Adding `name: "foo"` inside the object silently rejects the tool.

## Release process

See [RELEASE.md](RELEASE.md). v0.7.0 is local-only; future tags may be published per-plugin.
