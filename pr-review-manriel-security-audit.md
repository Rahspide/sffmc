# PR Comment: Manriel Security Audit Review

> **Готово к вставке в GitHub PR** (security-audit-fixes → main).
> Автор: Maks · 2026-06-19.
> Файл сохранён вне tracked-ветки, чтобы не светить draft-комментарий в репо до отправки.

---

Hey Manriel 👋

Massive thanks for going through this — 30 findings is real work, and the structure (severity tiers + concrete fix proposals) makes triage straightforward. I've gone through every item; below is the disposition with reasoning, examples where useful, and what I'd love to see before merge.

Quick mental model: I'm trying to balance two things — (1) accept real security wins, (2) avoid regressions or design changes that break existing workflows. Where I push back, it's usually a "let's iterate on this together" rather than a hard no.

## CRITICAL

**skills directory override (config) — Cap dream dedup entries to prevent O(n²) blowup** · ✅ Accept, but reclassify to **Medium**

Scenario: if memory grows to 50k entries, the Jaccard loop does ~1.25B comparisons and pegs CPU. The 5000-entry cap is a sensible safety net.

Why Medium not Critical: exploitation requires someone with write access to `~/.local/share/sffmc/memory/` to drop a huge file — that's already a compromised host scenario. In single-user trusted-host deployment this is resource hygiene, not a security boundary.

One UX nit: when the cap triggers, the user gets a `warn` in logs but no UI message. They might wonder why dedup isn't working. A one-time chat notice would help.

**skills directory override (filesystem) — Cap checkpoint session buffer map (max 50)** · 🟡 Needs a tweak

Love the cap, but I think there's a bug in the eviction logic. The comment says LRU, but the implementation uses `Map.keys().next().value` which returns the **first-inserted** key (FIFO), not the least-recently-used.

Scenario: imagine a 3-hour analysis workflow running, and concurrently 49 quick workflows. With FIFO eviction, the long-running session could get evicted mid-flight and lose buffered tool calls. With proper LRU, the idle sessions get evicted first.

Could you implement a real LRU (track last-access timestamp per entry, evict the oldest)? Also, like skills directory override (config), this is Medium severity given the local-only threat model.

**oversize checkpoint typed error — Reject oversized checkpoint files (>10MB)** · 🟡 Needs a tweak

Defensive cap is good, but error handling is inconsistent: `readHeader()` returns `null` on oversize, `readToolCalls()` returns `[]` with a warning. Callers can't distinguish "oversize" from "missing file" → confusing downstream behavior.

Pick one pattern (probably `null` + warning, or a typed error like `CheckpointTooLargeError`). Same Medium reclassification argument as skills directory override (config)/skills directory override (filesystem).

**Reject oversized AGENTS.md (>100KB)** · ✅ Accept

Best-justified Critical of the four — `AGENTS.md` is auto-discovered in every project root, so a maliciously-large file in a cloned repo can OOM us without any other write access.

Minor UX nit: legit AGENTS.md files in the 100KB–8KB-truncation range will get silently dropped. Debug-level log would help.

## HIGH

**Jail workflow file path resolution** · ✅ Accept

True path traversal. Scenario: a workflow with `{ name: "/etc/passwd" }` would otherwise read any host file.

Could you add a regression test asserting that `../../etc/passwd` is rejected at the jail boundary? That way the behavior is locked in.

**Jail `input.file` in resolveScript** · ✅ Accept

Symmetric protection with the workflow file path resolution jail. Same test request for `input.file` traversal.

**H3 — `http.extraHeader` instead of token in git URL** · ✅ Accept (unconditional)

Clean win — token in URL leaks to `/proc/<pid>/cmdline`, `~/.git/config`, shell history. No notes, ship it.

**GPG signature verification after clone/pull** · ✅ Accept

Solid defense-in-depth. One thing to flag: by default verification is soft-warn (no abort on failure), and if `gpg` isn't installed (common in Alpine containers), it's silently skipped. Strict mode requires `SFFMC_STRICT_GPG=1` (which you added in the supply-chain commit).

Question: should we make strict mode the default for installs? Or document that operators should set it explicitly?

**workflow recovery grace period — Sandbox deadline 12h → 1h** · ❌ Hold on this

I'm worried this is a regression. Scenario: a user runs a multi-hour data analysis workflow. With the 1h cap, it would now fail mid-way.

The 12h value might be intentional as a grace period after workflow timeout — e.g., for cleanup-after-kill. **Question for you**: was 12h chosen deliberately for that reason?

If yes → keep it. If no → propose a compromise (3h, 6h). Also: no integration test for actual deadline behavior exists, only the constant assertion was updated. Could you add one?

**parallel LLM candidates cap — Cap parallel LLM candidates at 10** · 🟡 Needs discussion

Want to push back here. The 50-candidate count in mimo-code max-mode is **intentional API behavior**, not a user-input cap. The mode is designed to spawn up to 50 parallel LLM candidates per task, and `generateCandidates()` is only called once or twice per workflow invocation. So `MAX_CANDIDATES = 10` would actually break the design.

Suggest reclassifying to Medium. If there's a budget-burn concern beyond self-inflicted, happy to discuss a separate budget guard rather than capping the candidate count.

**JSON.parse try/catch for corrupted DB — `try/catch` around `JSON.parse` for corrupted DB data** · ✅ Accept (with conditions)

Nice defensive parsing. Two asks:

1. Log at **debug** level so we don't lose the stack trace for real DB corruption. Current silent `undefined` hides useful context.
2. The IIFE try/catch pattern (`(() => { try { ... } catch { ... } })()`) is a bit unusual — a normal block reads better.

Severity-wise: robustness against corruption, not security boundary. Reclassify to Medium.

## MEDIUM

**YAML schema validation** · ✅ Accept

Defense-in-depth against future schema regressions. Ship it.

**ReDoS check for user-supplied regex** · ⏸ Deferred to v0.14.0 (already in beta)

**Use parent workspace for child workflow resolution** · ✅ Accept (reclassify to **Low**)

Good catch, but this is **correctness**, not security. Scenario: parent workflow at `<project-root>` spawns child named `bar` → child looks for `bar` in CWD rather than `<project-root>/`. That's a bug, but it doesn't cross a trust boundary. Reclassify to Low.

**Journal JSON parsed without schema validation** · ❌ Want to see schema first

Risk of overcomplicating the journal format. **Could you share the proposed Zod schema (or equivalent) before implementation?** That way we align on shape and avoid divergence from the existing v1 header (`{"v":1}`).

**Raw tool output stored in checkpoint** · 🟡 Needs refactor

Great catch — if a tool returns `cat ~/.ssh/id_rsa`, the raw output lands in checkpoint and stays there. But this **overlaps with filename and source-path rule coverage**.

Request: combine raw tool output + dream archive unredacted content + filename and source-path rules into a single shared `redact-secrets` helper at `shared/src/redact-secrets.ts`. One source of truth for what counts as sensitive — three separate regex lists will drift and someone will forget to apply one.

**Dream archive stores unredacted content** · 🟡 Same as above

Overlaps with raw tool output + filename and source-path rules. Unify via shared helper.

**Data directory permissions** · ✅ Accept (follow-up required)

Defensive perms are good. **Important limitation**: `mode: 0o700` applies only to `mkdirSync` — **existing data directories created before this fix will remain world-readable**. Could you add a separate follow-up commit with `chmodSync` for existing dirs? Also, new files inside the dir inherit umask 022 (not 077), so file-level perms still need addressing.

**`listRuns()` pagination** · ✅ Accept

Simple and safe. **Could you split this into its own commit?** Keeps `security-audit-fixes` focused on its scope.

**dream module state** · 🔍 Need to verify

Will dig into dream.ts myself to confirm the state in question. Will get back to you with a verdict.

**Restored message cap** · ✅ Accept (with note)

Good cap, but note: the slice happens **after** `reconstructMessages` processes all calls — so O(n) work still happens. The cap only limits downstream LLM context pollution. Recommend combining with **oversize checkpoint typed error's 10MB file cap** for full DoS protection.

## LOW

**filename rule — Skip sensitive filenames in memory indexing** · 🟡 Needs regex tightening

The `/private/i` pattern is **too aggressive**. It would match:

- `my-private-notes.md`
- `private-thoughts.txt`
- `Documents/private-projects/notes.md` (false positive — `basename()` doesn't catch this)

All my own notes, not secrets — would be silently blocked from memory. Could you drop `/private/i` or tighten to path-anchored regex (e.g., `(^|/)private($|-)`)?

**source-path rule — Filter sensitive source paths in LLM recon** · 🟡 Same as filename rule, plus full-path over-broad

Same pattern issues. Plus this checks the **full path**, so `/home/user/projects/credentials-checklist.md` would also get filtered. Let's combine filename rule and source-path rule into a shared `sensitive-patterns.ts` after we fix both.

**Log only Log only error message in event bus** · ✅ Accept (with note)

Nice cleanup. **Ask**: preserve stack trace at **trace**-level logging for debugging — current `e.message` only loses context for real event-bus errors.

**Document Document `panicMode` as shared mutable state + `resetPanicMode()`** · ✅ Accept

**lockMap `lockMap` grows without bound** · ✅ Already on main

Fixed in `b616eb5` (clearJournal race + lockMap leak + semaphore underflow). Thanks for the find — closing.

**TOCTOU TOCTOU race in WorkspaceJail** · ✅ Already on main

Fixed in `05909b8` (symlink-aware WorkspaceJail via `realpath`). Thanks — closing.

**L7 — Validate `WORKFLOW_LIMITS` before SQL DDL interpolation** · ✅ Accept

**Fsync Fsync timer not cleaned up on shutdown** · ⚠️ Partially on main

Partially addressed in `9a908c7` (checkpoint flush coalescing — 50ms debounce + exported `flushJournalSync`). Will monitor for shutdown issues; if they recur, more investigation needed.

**Log Log warnings on legacy migration failures** · ✅ Accept

## SUPPLY CHAIN (`d1d9c8c`)

Big win overall:

- ✅ SHA-pinned GitHub Actions (kills mutable-tag attacks)
- ✅ `Invoke-Expression` removal in `bin/sffmc.ps1` — genuine CVE-class fix
- ✅ `SFFMC_STRICT_GPG=1` escape hatch
- ⚠️ `bun.lock` jumped `0.10.1 → 0.12.0` (two minors). Could you double-check no breaking changes in workspace packages against current `CHANGELOG.md` before merge?

## DOCS (`1c0db57` — Containerised Testing in AGENTS.md)

Good policy. Two asks:

1. **Resolve the conflict with main's `b7faec7` (jargon cleanup)** — both modify `AGENTS.md` line ~47. I'll handle the manual merge, but you may want to be aware.
2. **Add a pre-commit hook or CI gate to enforce the policy** rather than relying on docs alone. Right now someone can ignore it without consequence.

## `.GITIGNORE` (`494c245`)

Already on main — no action.

## Summary

| Status | Count |
|---|---|
| ✅ Accepted (unconditional) | 12 |
| ✅ Accepted with conditions / reclassification | 6 |
| 🟡 Needs tweak (small fix) | 6 |
| ❌ Hold on this (bigger rework) | 2 |
| 🔍 Need to investigate | 1 |
| ⏸ Deferred to v0.14.0 | 1 |
| ✅ Already on main | 2 |
| ⚠️ Partially on main | 1 |

**Net**: 22 of 30 accepted (with conditions), 8 need rework/follow-up, 1 deferred, 2 already resolved on main. One manual merge required (`AGENTS.md`).

Looking forward to the revisions — let's get this merged cleanly. 🙌

---

## Closure Status — 2026-06-20

**All 30 items closed** across v0.14.0 → v0.14.1 → v0.14.2. Original `🟡` (6), `❌` (2), `🔍` (1), `⏸` (1) items resolved:

| Item | Disposition | Closed in | Commit / Note |
|---|---|---|---|
| skills directory override (filesystem) — Real LRU eviction | 🟡 → ✅ | v0.14.2 | `packages/extra/src/checkpoint.ts` — `_findLRUVictim` with `lastAccessMs` + `insertionOrder` tiebreaker |
| oversize checkpoint typed error — Typed `CheckpointTooLargeError` | 🟡 → ✅ | v0.14.2 | `packages/extra/src/checkpoint.ts` — exported class, both readers throw, callers degrade gracefully |
| Unified redact helper | 🟡 → ✅ | v0.14.0 | `shared/src/redact-secrets.ts` — single source of truth |
| Split listRuns LIMIT | 🟡 → ✅ | v0.14.0 | separate commit per Manriel's request |
| Filename and source-path rules — Narrow sensitive patterns | 🟡 → ✅ | v0.14.0 | `(^\|/)private($\|-)` anchored; path-anchored for source-path rule |
| Log error message + trace stack | 🟡 → ✅ | v0.14.0 | `e.message` at info, stack at trace |
| workflow recovery grace period — Sandbox deadline 12h → 1h | ❌ → ✅ | v0.14.2 | `SCRIPT_DEADLINE_MS = 1h` in `constants.ts:23`; cleanup-after-kill is the workflow recovery grace period grace period, not the sandbox deadline |
| parallel LLM candidates cap — Parallel candidates cap = 10 | ❌ → ✅ | v0.14.2 | `MAX_CANDIDATES = 10` retained; 45-line rationale comment in `candidates.ts` |
| dream module state | 🔍 → ✅ | v0.14.2 | `_activeDreamState` documented with race risk + migration path; concurrent test passes |
| (Deferred item) | ⏸ → ✅ | v0.14.0 | see `CHANGELOG.md` v0.14.0 release notes |

**Final test count:** 721 pass / 1 skip / 0 fail (was 710 in v0.14.1; +11 new from this round).

**Precommit gates:** 6/6 green.

**Push scope** (awaiting user signal):
- `v0.14.2-hardcode-phase1` branch → main (merge + tag `v0.14.2`)
- `main` → `origin/main` (currently 11 commits ahead)
- `v0.14.1` branch → `origin/v0.14.1`
- `v0.14` branch already pushed