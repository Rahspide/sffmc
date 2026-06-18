# SFFMC Drone CI Pipeline

This document describes the Drone CI pipeline for the SFFMC monorepo
(`Rahspide/sffmc`), the publish workflow, and the secrets required.

The pipeline is defined in [`.drone.yml`](../.drone.yml). This file is
the authoritative reference for the pipeline; this doc explains the
*why* behind the design.

## Pipeline overview

Drone runs a single pipeline named `default` with the following steps.
The first five steps run on **every push and pull request** to `main`,
giving fast feedback during development. The remaining steps are gated
on **tag pushes** matching `v*.*.*` (e.g. `v0.12.0`) and form the
publish workflow.

```
              push / pull_request                       tag push (v*.*.*)
              ───────────────────                       ─────────────────
   ┌─────────┐
   │ install │
   └────┬────┘
        ├─────► typecheck     ─┐
        ├─────► test          ─┤
        ├─────► verify-load   ─┤   (existing CI feedback loop)
        └─────► audit-public  ─┘

   (tag push only)
                          ┌─ tag-gate-typecheck  ─┐
                          ├─ tag-gate-test       ─┤
                          ├─ tag-gate-audit      ─┼─► publish ─► notify
                          └─ tag-gate-health     ─┘
```

### Step reference

| Step | Runs on | Purpose |
|---|---|---|
| `install` | push / PR / tag | `bun install --frozen-lockfile` |
| `typecheck` | push / PR / tag | `bun run typecheck` (0 errors) |
| `test` | push / PR / tag | `bun run test:all` (29 test files, ~180 cases) |
| `verify-load` | push / PR / tag | Load-order audit on the 3 composite packages |
| `audit-public` | push / PR / tag | `scripts/audit-public-content.sh` (no leaks) |
| `tag-gate-typecheck` | tag only | Re-run typecheck on the tag commit |
| `tag-gate-test` | tag only | Re-run full test suite on the tag commit |
| `tag-gate-audit` | tag only | Re-run public-content audit on the tag commit |
| `tag-gate-health` | tag only | `bun run scripts/run-health.ts` (all checks green) |
| `publish` | tag only, all gates green | `bun run scripts/release.sh --actual` |
| `notify` | tag only, regardless of publish outcome | Optional Slack/Discord webhook |

### Why pre-publish gates?

The first five steps validate **every** commit that lands on `main`. By
the time you push a `v*.*.*` tag, the gates are *expected* to be green.
We re-run them on the tag commit anyway as a final check, because:

1. The tag is the commit that ships — failure here is the worst time to
   discover a regression.
2. Tag commits are sometimes crafted from a working tree that diverged
   from `main` (hot-fixes, security patches).
3. `verify-load` and `audit-public` are cheap; running them twice costs
   almost nothing compared to a failed publish.

## Image pinning

Every step uses `oven/bun:1.3.14` (not `oven/bun:1` or `oven/bun:latest`).
The `1.3.14` pin matches the version used by contributors locally and
ensures reproducible builds.

## Caching

Two host-persistent volumes cache build state across runs:

| Volume | Host path | Mounted at |
|---|---|---|
| `node_modules` | `/var/lib/drone/sffmc-node_modules` | `/drone/src/node_modules` |
| `bun-cache` | `/var/lib/drone/sffmc-bun-cache` | `/root/.bun/install/cache` |

The `node_modules` volume is mounted on the `install` step; subsequent
steps read from it. `bun-cache` is mounted on every step to keep the
bun resolver warm.

If you ever upgrade Bun or the lockfile in a way that invalidates the
cache, delete the host directories and let the next build re-populate
them.

## Required secrets

The following drone secrets must exist for the tag-publish workflow to
work. They are set per-repository via the `drone` CLI or the Drone web
UI.

| Secret | Required? | Source | Used by step |
|---|---|---|---|
| `npm_token` | **Yes** | `~/.npmrc` ([REDACTED-NPM], bypass-2FA granular token, publish scope on `@sffmc`) | `publish` |
| `github_token` | Recommended | GitHub PAT with `repo` scope | `publish` |
| `slack_webhook` | Optional | Slack/Discord incoming-webhook URL | `notify` |

### Setting secrets via the CLI

```bash
# Activate the repo (one-time; also signs .drone.yml)
drone repo add Rahspide/sffmc

# Required: npm publish token
drone secret add --repository Rahspide/sffmc \
  --name npm_token --value "$NPM_TOKEN_FROM_NPMRC"

# Recommended: github PAT for post-publish status updates
drone secret add --repository Rahspide/sffmc \
  --name github_token --value "$GITHUB_PAT"

# Optional: slack/discord webhook
drone secret add --repository Rahspide/sffmc \
  --name slack_webhook --value "https://hooks.slack.com/services/..."
```

To extract the existing `npm_token` from your local `~/.npmrc`:

```bash
# Read the authToken line from your local npm config (DO NOT commit)
grep '_authToken' ~/.npmrc | sed 's/.*=//'
```

Drone secrets are encrypted at rest and exposed to pipeline steps as
environment variables named after the secret (e.g. `npm_token` →
`$NPM_TOKEN`).

## Publishing a new release

The end-to-end release flow is:

1. **Bump versions** in each `packages/*/package.json` and
   `shared/package.json` (or use `bun run version:list` to see the
   current state). Keep all 14 packages on the same version.

2. **Commit + push** the version bumps to `main`. Wait for CI to pass
   (the five feedback-loop steps).

3. **Tag the commit**:

   ```bash
   git tag v0.12.0
   git push origin v0.12.0
   ```

4. **Watch the build** in the Drone UI. The pipeline will:
   - Re-run the four tag-gates on the tag commit
   - Run `publish` (publishes all 14 packages to npm in dependency
     order — `shared/` first, then `packages/*` alphabetically)
   - Run `notify` (logs to drone; posts to Slack/Discord if
     `slack_webhook` is set)

5. **If publish fails partway** (e.g. 8 of 14 packages published, then
   network error), retry with:

   ```bash
   drone build promote Rahspide/sffmc <build-number> <target>
   ```

   This re-runs only the `publish` step (and its transitive deps) on
   the same build. Packages already published will fail with
   `bun publish --tolerate-republish` and the script will continue
   (see `scripts/release.sh` for retry semantics).

6. **After publish**, the `notify` step fires. If `slack_webhook` is
   not set, check the Drone build log for the publish summary.

### What `scripts/release.sh --actual` does

The publish step runs `bun run scripts/release.sh --actual`, which:

1. **Precondition checks** (fail-fast, exit 2 on any miss):
   - `bun` is on PATH
   - `git status --porcelain` is empty
   - `npm whoami` succeeds (uses `$NPM_TOKEN` from drone secret via
     `~/.npmrc` written by the step)
   - `npm org ls sffmc` succeeds
   - Tag `v0.9.0` exists (soft warning, not a hard fail)

2. **Publishes** in this order:
   - `shared/` (`@sffmc/shared`)
   - `packages/*/` alphabetically — 13 composite/standalone packages
     (`@sffmc/agentic`, `@sffmc/auto-max`, `@sffmc/compose`,
     `@sffmc/eos-stripper`, `@sffmc/extra`, `@sffmc/health`,
     `@sffmc/log-whitelist`, `@sffmc/max-mode`, `@sffmc/memory`,
     `@sffmc/rules`, `@sffmc/safety`, `@sffmc/watchdog`,
     `@sffmc/workflow`)

3. **Uses `bun publish --access public --tolerate-republish`** per
   package, so re-running the step on a partial publish doesn't
   fail-fast on already-published versions.

4. **Returns exit 0** on full success, **exit 1** if any package
   failed, **exit 2** if a precondition was unmet.

For the dry-run equivalent (no `npm_token` required, for local sanity
checks), use `bun run publish:dry-run` or `scripts/release.sh`.

## Manual override / retry

The publish step is the only step in the pipeline that needs
`npm_token`. The other secrets are inert on non-publish steps. If a
publish fails:

| Symptom | Fix |
|---|---|
| Tag-gate failed (test/typecheck/audit/health) | Fix the underlying issue, push a new commit, delete the old tag, re-tag |
| Publish failed (network / npm 5xx) | `drone build promote Rahspide/sffmc <build> <target>` |
| `npm_token` is invalid | Update the secret (`drone secret update`), then promote the build |
| All 14 packages published but step exited non-zero | Inspect the build log; usually a post-publish hook failed — promote to retry |

## HMAC signature

The `.drone.yml` ends with a `kind: signature` block whose `hmac` field
is a placeholder. The first time you run `drone repo add Rahspide/sffmc`,
the drone CLI signs the YAML with your Drone server's secret key and
replaces the placeholder with the real HMAC. Do **not** edit the
signature block manually — Drone will reject unsigned changes.

If you ever need to rotate the signature (e.g. Drone server key
rotation), remove the repo and re-add it:

```bash
drone repo rm Rahspide/sffmc
drone repo add Rahspide/sffmc
```

## Related files

- [`.drone.yml`](../.drone.yml) — the pipeline definition
- [`scripts/release.sh`](../scripts/release.sh) — the publish helper
- [`scripts/audit-public-content.sh`](../scripts/audit-public-content.sh) — public-content leak audit
- [`scripts/run-health.ts`](../scripts/run-health.ts) — `@sffmc/health` check runner
- [`RELEASE.md`](../RELEASE.md) — high-level release notes
- [`CHANGELOG.md`](../CHANGELOG.md) — version history
