## What does this PR do?
<!-- One-paragraph description. -->

## Motivation
<!-- Why is this change needed? Link to issue if any. -->

## How was it tested?
- [ ] `bun test` passes
- [ ] `bun run typecheck` passes
- [ ] `python3 scripts/audit-load-order.py` shows 0 conflicts
- [ ] `bun run scripts/run-health.ts` shows 12+ ok / 0 fail

## Checklist
- [ ] Updated relevant `README.md` / package docs
- [ ] Added/updated CHANGELOG entry
- [ ] No new `console.log` statements in production code
- [ ] No `// @ts-ignore` or `: any` in production source
- [ ] Each new public field has a corresponding `description` in package.json
