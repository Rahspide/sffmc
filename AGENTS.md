<!-- This file is AI agent instructions for working on this repo. See CONTRIBUTING.md for human-facing docs. -->

# SFFMC — Agent Instructions

A Bun-workspace monorepo of 14 SFFMC packages (3 composite + 10 sub-features + 1 SDK) porting killer features from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code). MIT licensed. v0.9.0 shipped.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md` (e.g. `packages/workflow/codemap.md` for the workflow engine).

## Architecture: composite

Every SFFMC plugin follows the **composite** pattern:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level state shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means `rm -rf packages/foo && bun test` should still pass for the remaining 12.

## Common Tasks

```bash
# Run all tests (uses bunfig.toml scope — excludes dependencies/MiMo-Code)
bun test

# Type-check (uses bun build --no-bundle, no global tsc needed)
bun run typecheck

# Run health diagnostic (13 checks, JSON output)
bun run scripts/run-health.ts

# Audit hook conflicts (0 conflicts expected)
python3 scripts/audit-load-order.py

# Build all plugins to /tmp/sffmc-build
bun run build

# Pre-commit runs 4 gates automatically
git commit -m "..."   # runs bun test + typecheck + audit + sffmc_health
```

## Containerised Testing (Security Policy)

**Do not run `bun`, `python3`, or project scripts directly on the host.** Use fresh Podman/Docker containers to isolate untrusted or semi-trusted code execution.

### Quick Reference

```bash
# Pull pinned images (once)
podman pull oven/bun:1.3.14
podman pull docker.io/library/python:3-alpine

# Run full test suite in a fresh bun container
podman run --rm -v "$(pwd)":/work -w /work oven/bun:1.3.14 \
  sh -c "bun install && bun test && bun run typecheck"

# Run hook conflict audit in a python container
podman run --rm -v "$(pwd)":/work -w /work docker.io/library/python:3-alpine \
  sh -c "apk add --no-cache python3 py3-pip >/dev/null 2>&1; python3 scripts/audit-load-order.py"

# Run health check in bun container
podman run --rm -v "$(pwd)":/work -w /work oven/bun:1.3.14 \
  sh -c "bun run scripts/run-health.ts"
```

### Rules

1. **Pin image tags** — always use `oven/bun:1.3.14` (matches CI), never `:latest`
2. **Mount read-write only when needed** — use `-v "$(pwd)":/work` for tests that write lockfiles or reports
3. **Use `--rm`** — containers are disposable; never leave running containers behind
4. **Never use host bun/python** — even if installed, all `bun test`, `bun run`, and `python3 scripts/*` commands go through containers
5. **One-shot execution** — prefer `sh -c "cmd1 && cmd2"` over entering interactive containers

## Plugin SDK Notes (OpenCode 1.17.x)

- The `tool` hook's **key** is the tool's name, NOT a `name` field inside the tool definition. Adding `name: "foo"` inside the object silently rejects the tool.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for full hook reference and the SDL pattern.

## Local Development

After editing a plugin, restart your OpenCode instance to pick up changes. Run `bun test` first to verify nothing is broken.

If you have two OpenCode instances (development + production), you can restart the development instance freely without affecting production work.

## See Also

- [codemap.md](codemap.md) — repository atlas
- [CONTRIBUTING.md](CONTRIBUTING.md) — plugin SDK reference, conventional commits
- [RELEASE.md](RELEASE.md) — publication prep checklist (5 decisions)
- [CHANGELOG.md](CHANGELOG.md) — per-version release notes
- [docs/load-order-audit.md](docs/load-order-audit.md) — hook conflict analysis

## Cloned Dependency Source

Read-only dependency source repositories are available under
`.slim/clonedeps/repos/` for inspection. Do not edit these clones.

- `.slim/clonedeps/repos/justjake__quickjs-emscripten/` — `justjake/quickjs-emscripten` at `df4efb9ef2cb25c417ecb57986da462d11b244ed` (v0.32.0); the QuickJS sandbox engine used by `packages/workflow/src/sandbox.ts`. Reach for this source when debugging handle leaks, deadline-interrupt semantics, or marshal-in/marshal-out edge cases in the workflow sandbox. Not needed for ordinary workflow development.
