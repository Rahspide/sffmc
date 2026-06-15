---
name: agentic:health-check
description: "Use when the user asks for plugin health, when something seems off, or before a major version bump. Runs sffmc_health: 12 checks covering SFFMC_PACKAGES (all 12 expected), TOOL_FILES (12 expected), config files, git state, load order, version consistency, and more."
hidden: true
---

# Running Health Checks

## The Rule

When something is broken and you don't know why, run `sffmc_health` first. It checks 12 invariants and reports which failed. Don't guess — instrument.

## The 12 Checks

1. **SFFMC_PACKAGES** — 12 expected packages present
2. **TOOL_FILES** — 12 expected tool files present
3. **config_files** — user YAML files exist (or defaults load cleanly)
4. **git_state** — clean tree or expected dirty
5. **load_order** — no conflicting plugin load order
6. **version_consistency** — all packages on the same version
7. **category_split** — mimo-port vs sffmc-original counts
8. **codemap_fresh** — `.slim/codemap.json` current
9. **hook_conflicts** — 2+ plugins registering same GATE hook
10. **readme_presence** — all packages have README.md
11. **changelog_currency** — CHANGELOG.md latest version matches root
12. **msp_structure** — MSP compose structure valid (added in Phase 6)

## Tool Call

```
sffmc_health()
// Returns: { ok: 12, warn: 0, fail: 0, details: [...] }
```

## Interpreting Results

| Result | Meaning |
|---|---|
| `ok: 12, fail: 0` | System healthy |
| `ok: 11, fail: 1` | 1 broken check — details show which check + which file |
| `ok: 10, warn: 2` | 2 warnings (deferred, not breaking yet) |
| `fail > 0` | Fix before proceeding |

## Common Failures and Fixes

- **SFFMC_PACKAGES fail** → `bun install` (workspace not linked)
- **version_consistency fail** → `npm version X.Y.Z` on the lagging packages
- **hook_conflicts fail** → read `audit-load-order.py` output, reorder plugins (see `agentic:resolve-hook-conflict`)
- **readme_presence fail** → write the missing README or accept the warning as deferred
- **codemap_fresh fail** → regenerate via `npx sffmc codegraph`

## When to Run

- User: "is everything ok?" → run
- Before `git commit` of a major refactor → run
- When it's in the pre-commit hook (it is!) → already runs; check the output
- When debugging a plugin issue → run first, read the failure, then fix

## Cost

1-2 seconds of wall time, no token cost (pure file existence + `grep`).

## Why This Skill Exists

`sffmc_health` catches 90% of "why is my plugin not loading" issues. Without it, the LLM guesses — and guesses wrong. This skill ensures the health check is always the first diagnostic step.
