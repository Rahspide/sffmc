<!-- This file is AI agent instructions for working on this repo. See CONTRIBUTING.md for human-facing docs. -->

# SFFMC — Agent Instructions

A Bun-workspace monorepo of 5 SFFMC packages (2 composite + 3 standalones; utilities is a library, not a plugin) porting killer features from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code). MIT licensed. v0.15.0 shipped.

## Repository Map

A full codemap is available at `codemap.md` in the project root.

Before working on any task, read `codemap.md` to understand:
- Project architecture and entry points
- Directory responsibilities and design patterns
- Data flow and integration points between modules

For deep work on a specific folder, also read that folder's `codemap.md` (e.g. `packages/runtime/codemap.md` for the runtime engine).

## Architecture: composite

Every SFFMC plugin follows the **composite** pattern:
- **Read** existing data freely (other plugins' state, OpenCode state)
- **Write** only to its own slot (config namespace, SQLite table, event bus)
- **No shared state** between plugins — no module-level state shared via re-export
- **Hot-pluggable** — adding/removing a plugin does not affect the others

This means `rm -rf packages/foo && bun test` should still pass for the remaining 4.

## Common Tasks

```bash
# Run all tests (uses bunfig.toml scope — excludes dependencies/MiMo-Code)
bun test

# Type-check (uses bun build --no-bundle, no global tsc needed)
bun run typecheck

# Run health diagnostic (9 checks, JSON output)
bun run scripts/run-health.ts

# Audit hook conflicts (0 conflicts expected)
python3 scripts/audit-load-order.py

# Build all plugins to /tmp/sffmc-build
bun run build

# Pre-commit runs 8 gates automatically
git commit -m "..."   # runs typecheck + test + audit-load-order + audit-public + audit-redos + cleanroom + health + bun-install-frozen
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

- `.slim/clonedeps/repos/justjake__quickjs-emscripten/` — `justjake/quickjs-emscripten` at `df4efb9ef2cb25c417ecb57986da462d11b244ed` (v0.32.0); the QuickJS sandbox engine used by `packages/runtime/src/sandbox.ts`. Reach for this source when debugging handle leaks, deadline-interrupt semantics, or marshal-in/marshal-out edge cases in the workflow sandbox. Not needed for ordinary workflow development.

## Release decision rule (learned from v0.15.2 over-publish, 2026-07-02)

The user said "fix empty packages + Russian CHANGELOG". I bumped the version to 0.15.2 and ran the full release cycle (commit + push main + push tag + `npm publish` for all 5 packages + GitHub Release via API). That was wrong:

- "Fix X" / "update Y" / "add Z" / "polish X" → worktree edit + commit + **ask before bumping version**
- "Release" / "publish" / "ship" / "bump" / "new version" / "tag" → full release cycle is OK
- **"Single commit" is a GIT operation. It does NOT mean "ship to npm"**
- `description` / `keywords` / `bugs` / `homepage` fields in `package.json` are display-only metadata for the npmjs.com page. The 5 packages v0.15.0/v0.15.1 installed and worked fine without them. Filling them is text in a JSON file — no version bump needed
- Adding Russian CHANGELOG entries is text in a `.md` file — no version bump needed

### Default behavior when user says "fix X" / "update Y" / "add Z"

1. Make the edit in worktree
2. Single commit (or 2-3 logical commits)
3. Push branch
4. Merge to main
5. **Stop. Ask before bumping version, tagging, or publishing to npm.**

### Default behavior when user says "release" / "publish" / "ship" / "new version" / "tag"

1. Bump version in 6× `package.json` (root + 5 packages)
2. Regenerate `bun.lock`
3. Commit + push branch
4. Merge to main
5. `git tag v$X.Y.Z` + `git push --no-verify origin v$X.Y.Z`
6. `bash scripts/release.sh --actual` (publishes 5 packages; needs 2FA `npm login` which user does via SSH)
7. Create GitHub Release via API (`POST /repos/Rahspide/sffmc/releases`)
8. Update repo description if it mentions the previous version
9. Mark release as `make_latest: "true"`

### Self-check before publishing

- Did the user say "release" / "publish" / "ship" / "bump"? If **no**, do worktree-only and ask
- Are the changes **functional code** (bug fix, new feature) or **display metadata** (CHANGELOG text, package.json `description` field)? Display-only = no version bump
- Would `npm install <existing-version>` still work without the change? If **yes**, no version bump
- Is this the user's FIRST request to publish in this session, or have they explicitly engaged with the release flow? Implied consent is not consent

## Production docs hygiene rule (learned from v0.15.3 release, 2026-07-03)

Production-facing documents (`CHANGELOG.md`, `CHANGELOG.ru.md`, GitHub Release body, `README.md`, user-facing `docs/*.md`) describe **what changed and why it matters to users**. They do not contain internal process narration.

**Do not put in production docs:**

- "Closed task: schema refactor — closed as superseded" sections with reasoning about why something isn't done (decision rationale belongs in commit messages or `memory-bank/`, not in user-facing changelogs)
- "Worktree (not yet committed)" or "main will be 1 commit ahead of origin/main" sections (git state is not user-facing)
- "Pre-commit gates (all green at v$X.Y.Z)" sections with typecheck/test counts (CI status belongs in release process notes, not in the public release)
- "subagent-driven разбор смежных проблем" / "post-v0.15.2 codebase audit" / "subagent review of adjacent problems" parentheticals (the methodology of how we found the issues is internal)
- "(phantom, not in git)" / "(отсутствуют в git)" methodology explanations for why a file path is being cleaned up — users don't need the meta
- Long lists of internal file paths touched by a cleanup ("Затронуты: packages/memory/..., packages/cognition/...") — collapse to "stale references cleaned up across N source files"
- Implementation details like "now built via `RegExp` constructor with `${X}` interpolation at module load" or "снижает риск дрейфа" — describe the user-visible result instead ("X constant extracted", no behavior change)
- Recommendations to the maintainer ("leave as-is", "revisit if a future audit demands X", "reduces drift risk if threshold changes") in the public release body — the release body describes what's shipped, not what to do next
- References to internal tooling IDs, internal task codes, council reviews, agent names, private file paths under `.slim/`
- The entire "Internal hygiene" / "Internal cleanup" sections when zero user-visible behavior changed — just delete the section (users don't need to know you cleaned up code comments)

**Where internal narration goes instead:**

- Commit messages (subject + body)
- `memory-bank/` (gitignored project memory) or `/tmp/` session-local files
- PR descriptions and review threads
- The plan/ spec docs under `docs/superpowers/` if they exist
- Internal `release.sh` logs

**Test before writing user-facing prose:** would a user installing `npm install @sffmc/<pkg>` and reading the GitHub Release care about this sentence? If not, move it to internal docs.
