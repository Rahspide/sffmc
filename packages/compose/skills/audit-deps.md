<!-- Copied verbatim from XiaomiMiMo/MiMo-Code @ 42e7da3 on 2026-06-14. License: see upstream LICENSE -->
---
name: compose:audit-deps
hidden: true
description: Use when you need to audit project dependencies — before adding a new dependency, during security reviews, before a release, or when cleaning up a project
---

# Dependency Audit

## Overview

Systematically audit a project's dependencies for outdated versions, known vulnerabilities, unused packages, and license issues. This skill guides the LLM through reading the manifest, running audit tools, analyzing results, and producing a structured report.

**Core principle:** Every dependency is a liability — verify they're worth it.

**Announce at start:** "I'm using the compose:audit-deps skill to audit project dependencies."

## When to Use

- Before adding a new dependency (audit existing ones first)
- Before a production release
- During a security review
- When cleaning up a project (what can we remove?)
- When a vulnerability is announced in the ecosystem
- As a periodic hygiene check (monthly)

**Don't use for:** projects with zero dependencies (the answer is "no issues").

## The Process

### Phase 1: Read the Manifest

Identify and read the project's dependency manifest:

| Ecosystem | Manifest | Lockfile |
|-----------|----------|----------|
| JavaScript/TypeScript (npm) | `package.json` | `package-lock.json` |
| JavaScript/TypeScript (Bun) | `package.json` | `bun.lockb` |
| JavaScript/TypeScript (pnpm) | `package.json` | `pnpm-lock.yaml` |
| JavaScript/TypeScript (yarn) | `package.json` | `yarn.lock` |
| Python | `pyproject.toml`, `requirements.txt` | `poetry.lock`, `requirements-lock.txt` |
| Rust | `Cargo.toml` | `Cargo.lock` |
| Go | `go.mod` | `go.sum` |
| Ruby | `Gemfile` | `Gemfile.lock` |

1. **Parse the manifest:** Extract all direct dependencies with their version constraints.
2. **Count them:** How many direct dependencies? How many are dev-only?
3. **Note the package manager:** Which commands will you use to audit?

### Phase 2: Check for Outdated Versions

Run the appropriate update-check command for the ecosystem:

```bash
# npm
npm outdated

# Bun
bun outdated

# pnpm
pnpm outdated

# yarn
yarn outdated

# Python (pip)
pip list --outdated

# Rust
cargo outdated

# Go
go list -u -m all
```

**For each outdated dependency, note:**
1. Current version vs. latest version
2. How far behind (major, minor, patch)
3. Does the changelog mention breaking changes?

**Categorize the urgency:**
- **Patch behind** (e.g., 2.1.0 → 2.1.3): Low risk — update when convenient.
- **Minor behind** (e.g., 2.1.0 → 2.5.0): Medium risk — read changelog, update in next sprint.
- **Major behind** (e.g., 2.1.0 → 3.0.0): High effort — breaking changes expected. Schedule dedicated migration time.
- **Multiple majors behind** (e.g., 1.0.0 → 4.0.0): Critical — the package may have unpatched vulnerabilities. Prioritize.

### Phase 3: Check for Known Vulnerabilities

Run the security audit command:

```bash
# npm
npm audit

# Bun
bun audit

# pnpm
pnpm audit

# yarn
yarn audit

# Python (safety)
pip-audit   # or: safety check

# Rust
cargo audit

# Go
govulncheck ./...
```

**For each vulnerability found:**
1. **CVE/GHSA ID** — the advisory identifier
2. **Severity** — critical, high, moderate, low
3. **Affected package and version range**
4. **Is there a fix?** What version contains the patch?
5. **Is it reachable?** Is the vulnerable code path actually used in this project? (Not every vulnerability is exploitable.)
6. **Is there a workaround?** Can you mitigate without upgrading?

**If the audit tool is not available**, fall back to checking the manifest manually against known vulnerability databases — but note this is a limited check.

### Phase 4: Check for Unused Dependencies

Identify packages that are listed but never imported:

**For JavaScript/TypeScript:**
```bash
# npx depcheck (npm)
npx depcheck

# Bun equivalent
bun x depcheck

# ESLint plugin (alternative)
npx eslint . --rule 'import/no-unused-modules: error'
```

**For other ecosystems**, manually scan imports against the manifest:
1. Extract all import/require statements from source files.
2. Cross-reference against `dependencies` and `devDependencies`.
3. Flag any dependency not found in imports.

**Note:** Some packages are used in config files (e.g., `eslint-plugin-*`, `tailwindcss`), build scripts, or are peer dependencies. These are not "unused" — they're just not directly imported. Mark them as "indirect usage" rather than flagging them.

### Phase 5: Check for License Issues

1. **Extract licenses:**
   ```bash
   # JavaScript
   npx license-checker --summary

   # Rust
   cargo license

   # Python
   pip-licenses
   ```

2. **Categorize each license:**
   - **Permissive** (MIT, Apache-2.0, BSD, ISC, Unlicense): No restrictions — safe for any project.
   - **Copyleft** (GPL-2.0, GPL-3.0, AGPL-3.0): Requires derivative works to use the same license. May conflict with proprietary or permissive-licensed projects.
   - **Strong Copyleft** (AGPL-3.0 with network clause): Even network use triggers the copyleft requirement. High risk for SaaS.
   - **Unlicensed / Unknown**: No license means default copyright — you have no right to use it.

3. **Flag conflicts:**
   - GPL dependency in an MIT project → legal risk.
   - AGPL dependency in a proprietary SaaS → likely unacceptable.
   - Missing license file → the package may not be legally usable.

### Phase 6: Output the Audit Report

Produce a structured report:

```markdown
## Dependency Audit Report: [Project Name]

**Date:** [YYYY-MM-DD]
**Ecosystem:** [npm/Bun/Python/Rust/Go]
**Manifest:** [path to manifest]
**Summary:** [Total deps] direct, [N] outdated, [N] vulnerable, [N] unused, [N] license issues

---

### Outdated Dependencies
| Package | Current | Latest | Behind | Risk | Action |
|---------|---------|--------|--------|------|--------|
| lodash  | 4.17.20 | 4.17.21 | 1 patch | Low | `npm update lodash` |
| express | 4.18.0  | 5.0.0  | 1 major | High | Migration plan needed |

### Vulnerabilities
| ID | Package | Severity | Affected | Fixed In | Reachable? | Action |
|----|---------|----------|----------|----------|------------|--------|
| GHSA-xxxx | axios | High | <1.7.0 | 1.7.0 | Yes (used in auth flow) | Update to 1.7.0+ |

### Unused Dependencies
| Package | Type | Evidence | Action |
|---------|------|----------|--------|
| moment | dependency | No imports found | Remove or replace with native Date |

### License Issues
| Package | License | Conflict | Action |
|---------|---------|----------|--------|
| some-lib | GPL-3.0 | Project is MIT | Replace with MIT-licensed alternative |
| other-lib | UNLICENSED | No usage rights | Remove immediately |

### Recommendations
- **Immediate:** [Critical/High vulnerabilities to fix now]
- **This sprint:** [Outdated deps, unused deps to clean up]
- **Next sprint:** [Major version migrations]
- **Policy:** [License issues requiring team discussion]
```

## Heuristics

- **Direct vs. transitive:** Focus on direct dependencies — you control them. Transitive dependency issues should be fixed by updating the direct dependency that pulls them in.
- **Dev-only dependencies:** Vulnerabilities in dev dependencies matter less (not in production bundle), but still fix them — they can compromise CI or developer machines.
- **One outdated dependency at a time.** Updating 20 packages simultaneously makes it impossible to identify which one broke the build. Update, test, commit — repeat.
- **Pinned versions are a smell.** `"lodash": "4.17.20"` (exact pin) prevents automatic patch updates that fix vulnerabilities. Use `~` or `^` ranges unless you have a specific reason to pin.
- **Check the changelog before major upgrades.** A major version bump may require code changes. Read the migration guide first.
- **Remove before replace.** If a package is unused, remove it rather than updating it. Fewer dependencies = smaller attack surface.

## Red Flags — STOP

- Adding a new dependency without auditing existing ones first → **compounding technical debt**
- Ignoring a Critical/High vulnerability because "it probably doesn't affect us" → **verify, don't assume**
- Updating all outdated dependencies at once without testing → **breaking the build**
- Keeping an unused dependency "just in case" → **every unused dep is dead weight and a potential vulnerability**
- Accepting a copyleft dependency without legal review → **you may be relicensing the entire project**

## Integration

After the audit report is complete:
- Use **compose:report** to include audit findings in the final report.
- For vulnerability fixes, use **compose:tdd** to ensure fixes don't break functionality.
- For major version migrations, use **compose:plan** to create a migration plan.
- For removing unused dependencies, use **compose:verify** to confirm nothing breaks after removal.
