# PR Comment: Manriel Security Audit Review

> **Готово к вставке в GitHub PR** (security-audit-fixes → main).
> Автор: Maks · 2026-06-19.
> Файл сохранён вне tracked-ветки, чтобы не светить draft-комментарий в репо до отправки.

---

Hey Manriel 👋

Massive thanks for going through this — 30 findings is real work, and the structure (severity tiers + concrete fix proposals) makes triage straightforward. I've gone through every item; below is the disposition with reasoning, examples where useful, and what I'd love to see before merge.

Quick mental model: I'm trying to balance two things — (1) accept real security wins, (2) avoid regressions or design changes that break existing workflows. Where I push back, it's usually a "let's iterate on this together" rather than a hard no.

## CRITICAL

**C1 — Cap dream dedup entries to prevent O(n²) blowup** · ✅ Accept, but reclassify to **Medium**

Scenario: if memory grows to 50k entries, the Jaccard loop does ~1.25B comparisons and pegs CPU. The 5000-entry cap is a sensible safety net.

Why Medium not Critical: exploitation requires someone with write access to `~/.local/share/sffmc/memory/` to drop a huge file — that's already a compromised host scenario. In single-user trusted-host deployment this is resource hygiene, not a security boundary.

One UX nit: when the cap triggers, the user gets a `warn` in logs but no UI message. They might wonder why dedup isn't working. A one-time chat notice would help.

**C2 — Cap checkpoint session buffer map (max 50)** · 🟡 Needs a tweak

Love the cap, but I think there's a bug in the eviction logic. The comment says LRU, but the implementation uses `Map.keys().next().value` which returns the **first-inserted** key (FIFO), not the least-recently-used.

Scenario: imagine a 3-hour analysis workflow running, and concurrently 49 quick workflows. With FIFO eviction, the long-running session could get evicted mid-flight and lose buffered tool calls. With proper LRU, the idle sessions get evicted first.

Could you implement a real LRU (track last-access timestamp per entry, evict the oldest)? Also, like C1, this is Medium severity given the local-only threat model.

**C3 — Reject oversized checkpoint files (>10MB)** · 🟡 Needs a tweak

Defensive cap is good, but error handling is inconsistent: `readHeader()` returns `null` on oversize, `readToolCalls()` returns `[]` with a warning. Callers can't distinguish "oversize" from "missing file" → confusing downstream behavior.

Pick one pattern (probably `null` + warning, or a typed error like `CheckpointTooLargeError`). Same Medium reclassification argument as C1/C2.

**C4 — Reject oversized AGENTS.md (>100KB)** · ✅ Accept

Best-justified Critical of the four — `AGENTS.md` is auto-discovered in every project root, so a maliciously-large file in a cloned repo can OOM us without any other write access.

Minor UX nit: legit AGENTS.md files in the 100KB–8KB-truncation range will get silently dropped. Debug-level log would help.

## HIGH

**H1 — Jail workflow file path resolution** · ✅ Accept

True path traversal. Scenario: a workflow with `{ name: "/etc/passwd" }` would otherwise read any host file.

Could you add a regression test asserting that `../../etc/passwd` is rejected at the jail boundary? That way the behavior is locked in.

**H2 — Jail `input.file` in resolveScript** · ✅ Accept

Symmetric protection with H1. Same test request for `input.file` traversal.

**H3 — `http.extraHeader` instead of token in git URL** · ✅ Accept (unconditional)

Clean win — token in URL leaks to `/proc/<pid>/cmdline`, `~/.git/config`, shell history. No notes, ship it.

**H4 — GPG signature verification after clone/pull** · ✅ Accept

Solid defense-in-depth. One thing to flag: by default verification is soft-warn (no abort on failure), and if `gpg` isn't installed (common in Alpine containers), it's silently skipped. Strict mode requires `SFFMC_STRICT_GPG=1` (which you added in the supply-chain commit).

Question: should we make strict mode the default for installs? Or document that operators should set it explicitly?

**H5 — Sandbox deadline 12h → 1h** · ❌ Hold on this

I'm worried this is a regression. Scenario: a user runs a multi-hour data analysis workflow. With the 1h cap, it would now fail mid-way.

The 12h value might be intentional as a grace period after workflow timeout — e.g., for cleanup-after-kill. **Question for you**: was 12h chosen deliberately for that reason?

If yes → keep it. If no → propose a compromise (3h, 6h). Also: no integration test for actual deadline behavior exists, only the constant assertion was updated. Could you add one?

**H6 — Cap parallel LLM candidates at 10** · 🟡 Needs discussion

Want to push back here. The 50-candidate count in mimo-code max-mode is **intentional API behavior**, not a user-input cap. The mode is designed to spawn up to 50 parallel LLM candidates per task, and `generateCandidates()` is only called once or twice per workflow invocation. So `MAX_CANDIDATES = 10` would actually break the design.

Suggest reclassifying to Medium. If there's a budget-burn concern beyond self-inflicted, happy to discuss a separate budget guard rather than capping the candidate count.

**H7 — `try/catch` around `JSON.parse` for corrupted DB data** · ✅ Accept (with conditions)

Nice defensive parsing. Two asks:

1. Log at **debug** level so we don't lose the stack trace for real DB corruption. Current silent `undefined` hides useful context.
2. The IIFE try/catch pattern (`(() => { try { ... } catch { ... } })()`) is a bit unusual — a normal block reads better.

Severity-wise: robustness against corruption, not security boundary. Reclassify to Medium.

## MEDIUM

**M1 — `Schema.JSON` for YAML parsing in rules** · ✅ Accept

Defense-in-depth against future schema regressions. Ship it.

**M2 — ReDoS check for user-supplied regex** · ⏸ Deferred to v0.14.0 (already in beta)

**M3 — Use parent workspace for child workflow resolution** · ✅ Accept (reclassify to **Low**)

Good catch, but this is **correctness**, not security. Scenario: parent workflow at `/data/projects/foo` spawns child named `bar` → child looks for `bar` in CWD rather than `/data/projects/foo/`. That's a bug, but it doesn't cross a trust boundary. Reclassify to Low.

**M4 — Journal JSON parsed without schema validation** · ❌ Want to see schema first

Risk of overcomplicating the journal format. **Could you share the proposed Zod schema (or equivalent) before implementation?** That way we align on shape and avoid divergence from the existing v1 header (`{"v":1}`).

**M5 — Raw tool output stored in checkpoint** · 🟡 Needs refactor

Great catch — if a tool returns `cat ~/.ssh/id_rsa`, the raw output lands in checkpoint and stays there. But this **overlaps with L1/L2 sensitive-pattern coverage**.

Request: combine M5 + M6 + L1/L2 into a single shared `redact-secrets` helper at `shared/src/redact-secrets.ts`. One source of truth for what counts as sensitive — three separate regex lists will drift and someone will forget to apply one.

**M6 — Dream archive stores unredacted content** · 🟡 Same as M5

Overlaps with M5 + L1/L2. Unify via shared helper.

**M7 — Restrictive file permissions on data directories** · ✅ Accept (follow-up required)

Defensive perms are good. **Important limitation**: `mode: 0o700` applies only to `mkdirSync` — **existing data directories created before this fix will remain world-readable**. Could you add a separate follow-up commit with `chmodSync` for existing dirs? Also, new files inside the dir inherit umask 022 (not 077), so file-level perms still need addressing.

**M8 — `listRuns()` without LIMIT/OFFSET** · ✅ Accept

Simple and safe. **Could you split this into its own commit?** Keeps `security-audit-fixes` focused on its scope.

**M9 — Module-level mutable state in dream.ts** · 🔍 Need to verify

Will dig into dream.ts myself to confirm the state in question. Will get back to you with a verdict.

**M10 — Cap restored messages from checkpoint to 50** · ✅ Accept (with note)

Good cap, but note: the slice happens **after** `reconstructMessages` processes all calls — so O(n) work still happens. The cap only limits downstream LLM context pollution. Recommend combining with **C3's 10MB file cap** for full DoS protection.

## LOW

**L1 — Skip sensitive filenames in memory indexing** · 🟡 Needs regex tightening

The `/private/i` pattern is **too aggressive**. It would match:

- `my-private-notes.md`
- `private-thoughts.txt`
- `Documents/private-projects/notes.md` (false positive — `basename()` doesn't catch this)

All my own notes, not secrets — would be silently blocked from memory. Could you drop `/private/i` or tighten to path-anchored regex (e.g., `(^|/)private($|-)`)?

**L2 — Filter sensitive source paths in LLM recon** · 🟡 Same as L1, plus full-path over-broad

Same pattern issues. Plus this checks the **full path**, so `/home/user/projects/credentials-checklist.md` would also get filtered. Let's combine L1 + L2 into a shared `sensitive-patterns.ts` after we fix both.

**L3 — Log only error message in event bus** · ✅ Accept (with note)

Nice cleanup. **Ask**: preserve stack trace at **trace**-level logging for debugging — current `e.message` only loses context for real event-bus errors.

**L4 — Document `panicMode` as shared mutable state + `resetPanicMode()`** · ✅ Accept

**L5 — `lockMap` grows without bound** · ✅ Already on main

Fixed in `b616eb5` (R3 clearJournal race + R4 lockMap leak + semaphore underflow). Thanks for the find — closing.

**L6 — TOCTOU race in WorkspaceJail** · ✅ Already on main

Fixed in `05909b8` (R5 symlink-aware WorkspaceJail via `realpath`). Thanks — closing.

**L7 — Validate `WORKFLOW_LIMITS` before SQL DDL interpolation** · ✅ Accept

**L8 — Fsync timer not cleaned up on shutdown** · ⚠️ Partially on main

Partially addressed in `9a908c7` (checkpoint flush coalescing — 50ms debounce + exported `flushJournalSync`). Will monitor for shutdown issues; if they recur, more investigation needed.

**L9 — Log warnings on legacy migration failures** · ✅ Accept

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