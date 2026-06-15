<!-- Copied verbatim from XiaomiMiMo/MiMo-Code @ 42e7da3 on 2026-06-14. License: see upstream LICENSE -->
---
name: compose:code-review
hidden: true
description: Use when you need a structured code review — after completing a feature, before merging, or when asked to review someone else's code
---

# Structured Code Review

## Overview

Walk through a systematic code review covering correctness, style, performance, and security. This skill guides the LLM through a phase-by-phase review that produces a structured report with severity-tagged findings. The reviewer acts as a fresh pair of eyes — assume nothing, verify everything.

**Core principle:** Methodical review catches what ad-hoc skimming misses.

**Announce at start:** "I'm using the compose:code-review skill to perform a structured review."

## When to Use

- After completing a non-trivial feature
- Before merging a PR
- When asked "review this code"
- As a checkpoint in compose:execute before reporting
- When you suspect bugs but can't find them

**Skip** for trivial one-liner changes (typo fixes, formatting-only diffs, config value changes).

## The Process

### Phase 1: Identify What Changed

Before reviewing, understand the scope.

1. **If in a git repo**, get the diff:
   ```bash
   git diff --stat HEAD~1   # vs previous commit
   git diff --stat main     # vs main branch
   git diff                 # unstaged changes
   ```
2. **If given a description**, restate it in your own words to confirm understanding.
3. **Note the files touched** — which are core logic, which are tests, which are config.

**Output at end of Phase 1:** A one-sentence summary of what this change does and which files matter most.

### Phase 2: Check Correctness

For each changed file that contains logic (skip test files, config):

1. **Trace data flow:** For each function, trace input → transformations → output. Does every path produce a valid result?
2. **Edge cases:** What happens with empty input? Null/undefined? Very large input? Negative numbers? Boundary values?
3. **Error handling:** Are errors caught? Do error messages help debugging? Are promises rejected properly?
4. **State mutations:** Does the code mutate shared state unexpectedly? Are there race conditions in async code?
5. **Assumptions:** Are there implicit assumptions that could break? (e.g., "this array will always have at least one element")

**For each issue found**, record it immediately:
```
[Phase 2] file.ts:42 — off-by-one: loop runs i <= arr.length, will access arr[arr.length] which is undefined
```

### Phase 3: Check Style

1. **Naming:** Are variable/function names descriptive? Do they follow the project's conventions (camelCase, snake_case, etc.)?
2. **Consistency:** Does this code match the patterns used elsewhere in the project?
3. **Comments:** Are complex sections explained? Are there misleading or stale comments?
4. **Dead code:** Are there commented-out blocks, unused imports, unreachable branches?
5. **Magic numbers:** Are unexplained constants given names?

**Style issues are always severity: Minor** (unless they obscure bugs — then escalate).

### Phase 4: Check Performance

Look for patterns that degrade at scale:

1. **Nested loops** that could be O(n²) when a linear pass would work.
2. **Repeated expensive operations** inside loops (regex compilation, file I/O, network calls).
3. **Unbounded memory growth** — arrays that grow without limit, missing pagination.
4. **Synchronous blocking** in async contexts (sync file reads, CPU-heavy loops on the main thread).
5. **Missing caching** for repeated expensive computations.

**Performance issues are severity: Important** unless they affect correctness under load — then escalate to **Critical**.

### Phase 5: Check Security

1. **Injection risks:** Is user input concatenated into shell commands, SQL queries, HTML, or URLs without sanitization?
2. **Secrets:** Are API keys, tokens, or passwords hardcoded? In environment variables (acceptable) vs. source code (not acceptable)?
3. **Input validation:** Is all user/external input validated and sanitized before use?
4. **Path traversal:** Are file paths constructed from user input without validation?
5. **Dependencies:** Are new dependencies introduced? (Flag for separate audit — see compose:audit-deps)

**Security issues are always severity: Critical** — no exceptions.

### Phase 6: Output the Review

Produce a structured report in this format:

```markdown
## Code Review: [Feature/Branch Name]

**Summary:** [One sentence about the change]

**Files reviewed:** [count] files, [count] lines changed

---

### Strengths
- [What the code does well — be specific]

### Issues

**🔴 Critical** (must fix before merge)
| # | File | Line | Issue | Suggestion |
|---|------|------|-------|------------|
| 1 | ... | ... | ... | ... |

**🟡 Important** (should fix before next task)
| # | File | Line | Issue | Suggestion |
|---|------|------|-------|------------|
| 1 | ... | ... | ... | ... |

**🟢 Minor** (note for later)
| # | File | Line | Issue | Suggestion |
|---|------|------|-------|------------|
| 1 | ... | ... | ... | ... |

### Recommendations
- [Any overall suggestions not tied to a specific line]

### Assessment
- [ ] Ready to merge as-is
- [ ] Ready after Critical issues fixed
- [ ] Needs re-review after fixes
```

## Reviewer Heuristics

- **Be specific.** "This is wrong" → ❌. "The condition on line 42 checks `x > 0` but should be `x >= 0` to include zero" → ✅.
- **Be constructive.** Every issue should include a suggestion for how to fix it.
- **Don't nitpick.** If the codebase uses `let` everywhere, don't flag individual `let` uses as style issues. Follow the project's conventions, not your preferences.
- **Acknowledge good work.** The Strengths section isn't flattery — it tells the author what patterns to keep using.
- **If no issues found, say so.** A review with zero findings is valid if the code is genuinely clean. Don't invent issues.

## Integration

After review is complete:
- If Critical issues found: fix them before proceeding. Re-review the fixes.
- If only Important issues: fix before the next task, but merging can proceed.
- If only Minor issues: note them and move on.
- Use **compose:report** to summarize the review outcome in the final report.
- Use **compose:verify** to confirm fixes before re-review.

## Red Flags — STOP

- Reviewing without reading the actual diff/description → **you are making things up**
- Reporting "looks good" without phase-by-phase analysis → **you skipped the work**
- Missing an obvious security issue → **the review is worse than no review** (false confidence)
- Reviewing your own code without the discipline of fresh eyes → **use a subagent** (compose:subagent with a code-reviewer template)
