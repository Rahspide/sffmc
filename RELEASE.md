# Release process

> **Current state (2026-06-15)**: v0.7.0 is tagged locally (`b05df59`). **No git remote is configured.** Publishing to npm/GitHub requires decisions captured below.

## Versioning

- Root `package.json` tracks the overall suite (0.7.0 as of this writing)
- Each plugin in `packages/*/package.json` has its own version (0.1.0 starting; bump per breaking change)
- Bump only the root when shipping a curated multi-plugin release
- Bump a single plugin's version if shipping independently (e.g. via `npm publish`)

## Tagging locally

```bash
# 1. Update root CHANGELOG.md
$EDITOR CHANGELOG.md  # add v0.X.Y section at top

# 2. Commit
git add CHANGELOG.md
git commit -m "docs: v0.X.Y changelog entry"

# 3. Tag
git tag -a v0.X.Y -m "v0.X.Y — short description

  - bullet 1
  - bullet 2"

# 4. Verify
git show v0.X.Y
git tag -l  # should list v0.6.0 v0.6.1 v0.X.Y
```

## Publishing per-plugin to npm (not yet wired)

When you decide to publish:

1. **Choose npm scope**: `@sffmc/*` (requires org creation at npmjs.com) or unscoped (`sffmc-memory`, etc.) — **DECISION NEEDED**
2. **Update each `packages/*/package.json`**:
   - Set `"name": "@sffmc/memory"` (already done)
   - Set `"repository"`, `"homepage"`, `"bugs"` fields
   - Add `"publishConfig": { "access": "public" }` for scoped packages
   - Add `"keywords"`, `"author"`, `"files"` (e.g. `["src", "LICENSE", "README.md"]`)
3. **Add `.npmignore`** to each package (or use `"files"` field):
   ```
   node_modules/
   src/*.test.ts
   tests/
   *.bak-*
   ```
4. **Auth**: `npm login` once, then `npm publish` per package (or use `bun publish`)
5. **CI**: GitHub Actions can do this on tag push. **DECISION NEEDED**: GitHub vs GitLab vs none.

## Monorepo publishing

Two patterns to choose between — **DECISION NEEDED**:

| Pattern | Tool | Pros | Cons |
|---|---|---|---|
| **Independent versioning** | Changesets or Nx | Each plugin publishes on its own version; downstream can pin one without others | More setup, more cognitive load |
| **Lockstep versioning** | Current (manual) | Simple; one tag, all plugins same version | Downstream must take all-or-nothing |

SFFMC currently uses **lockstep** (root version = all plugin versions). Independent versioning would require migrating to a workspace tool that supports it.

## CI

None configured. Suggested GitHub Actions workflow (if/when remote is GitHub):

```yaml
# .github/workflows/ci.yml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v1
        with: { bun-version: latest }
      - run: bun install
      - run: bun test
      - run: bun run typecheck
      - run: python3 scripts/audit-load-order.py  # 0 hook conflicts gate
```

## Decisions needed before first publish

1. **Git remote**: GitHub, GitLab, Codeberg, or local-only forever?
2. **License per package**: MIT (root) — already consistent, just copy LICENSE to each `packages/*/`
3. **npm scope**: `@sffmc/*` (requires npm org) or unscoped?
4. **Per-plugin vs lockstep versioning**: current = lockstep, OK for v0.7.0-v0.9.0
5. **CI provider**: GitHub Actions (needs GitHub), GitLab CI (needs GitLab), or none?

None of these block local development. They only matter at the moment you want someone else to install `@sffmc/workflow` from npm.
