# SFFMC — Agent Instructions

A Bun-workspace monorepo of 11 OpenCode plugins porting killer features from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code). MIT licensed. v0.8.0 shipped.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md` (e.g. `packages/workflow/codemap.md` for the W5-6 workflow engine).

## Architecture: DLC (Drop-in Lattice Components)

Every SFFMC plugin follows the **DLC** pattern:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level singletons shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means `rm -rf packages/foo && bun test` should still pass for the remaining 10.

## Common Tasks

```bash
# Run all tests (uses bunfig.toml scope — excludes dependencies/MiMo-Code)
bun test

# Type-check (uses bun build --no-bundle, no global tsc needed)
bun run typecheck

# Run F3+ Health diagnostic (11 checks, JSON output)
bun run scripts/run-health.ts

# Audit hook conflicts (0 conflicts expected)
python3 scripts/audit-load-order.py

# Build all plugins to /tmp/sffmc-build
bun run build

# Pre-commit runs 4 gates automatically
git commit -m "..."   # runs bun test + typecheck + audit + sffmc_health
```

## Plugin SDK Notes (OpenCode 1.17.x)

- The `tool` hook's **key** is the tool's name, NOT a `name` field inside the tool definition. Adding `name: "foo"` inside the object silently rejects the tool.
- See [CONTRIBUTING.md](CONTRIBUTING.md) for full hook reference and the SDL pattern.

## Sandbox Workflow

SFFMC is developed on the `opencode-sandbox` instance (port `:4200`) so you can restart freely without killing your prod session. The sandbox service is `opencode-sandbox.service` (separate from `opencode-root.service` at `:4100`).

After editing a plugin in `/data/projects/SFFMC/packages/<plugin>/src/`:
```bash
sudo systemctl restart opencode-sandbox.service
tail -f /home/opencode/.opencode-staging/opencode-bundle-patch-sandbox/logs/opencode-*.log
```

**Do NOT** restart `opencode-root` from inside an opencode web session — it self-kills the active session. Use a separate SSH terminal for prod restarts.

## See Also

- [codemap.md](codemap.md) — repository atlas
- [CONTRIBUTING.md](CONTRIBUTING.md) — plugin SDK reference, conventional commits
- [RELEASE.md](RELEASE.md) — publication prep checklist (5 decisions)
- [CHANGELOG.md](CHANGELOG.md) — per-version release notes
- [docs/v8-decision.md](docs/v8-decision.md) — original 8-feature plan and cut rationale
- [docs/load-order-audit.md](docs/load-order-audit.md) — hook conflict analysis
