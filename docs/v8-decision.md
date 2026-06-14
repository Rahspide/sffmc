# v8 Decision

## Status

**v8.0.0 — all 8 features confirmed by user on 2026-06-14.** **W1 ✅ DONE 2026-06-14** — commits 5173cea + 324fbb4 + a15818c, sandbox live on :4200, prod :4100 unaffected, 19/19 tests pass, runtime guard in place. **W2 ✅ DONE 2026-06-14** — commit f4b6ef5, 86/86 tests pass across 5 packages, 5/5 SFFMC plugins loaded. **W3 ✅ DONE 2026-06-14** — commit 0411ca7, 51 new tests (31 max-mode + 20 auto-max), 7/7 SFFMC plugins loaded, sandbox healthy on :4200. **W4 ✅ DONE 2026-06-14** — commit be3f999, 15 skills imported from MiMo-Code, 20/20 tests pass, 8/8 SFFMC plugins loaded, import-from-mimo guide (283 lines) shipped.

| Week | Features | Effort | Status |
|------|----------|--------|--------|
| W1 | F4' Memory + F2 Rules + OpenCode-migration README | 18-24h | ✅ DONE |
| W2 | F1 Watchdog + EOS stripper + log whitelist | 14-18h | ✅ DONE |
| W3 | F7 Max Mode + Auto-Max triggers | 12-16h | ✅ DONE |
| W4 | Compose pack + Verify skill + "Import from MiMo" guide | 4-6h | ✅ DONE |
| W5-6 | Dynamic Workflow (sandbox + JS primitives) | 25-35h | pending |
| W7 | Buffer, integration, Git publication prep | — | pending |

## Ships in v8.0 (8 features)

1. **F4' Memory + Context Recon 8K** — agent remembers your project + structured injection at session start
2. **F2 Rules** — safety net for destructive ops (rm -rf / DROP TABLE / chmod 777)
3. **F1 Watchdog** — agent auto-recovers after 3 failed tools
4. **F7 Max Mode** — 3 parallel drafts + judge for hard problems
5. **Auto-Max triggers** — F1+F2 auto-call F7 (5% extra overhead)
6. **Dynamic Workflow** — sandboxed JS with `agent()` / `parallel()` / `pipeline()` for 200+ step tasks
7. **Verify skill** — "no completion claims without fresh verification evidence"
8. **Compose pack** — 15 ready-made skills (plan / tdd / verify / subagent / etc) ported from MiMo-Code

## Cut to v8.1+

- **F3+ Health** — diagnostic for plugin authors, not end users. The one time you need it, you can run it manually.
- **F5' Checkpoint** — fires rarely for high engineering cost. Real users don't hit 200K-token sessions daily.
- **F6' Judge** — judge model cost vs a simple 1-line prompt check. Cute, but marginal.
- **F8 Dream** — 100h of plumbing (gates, snapshots, reversibility, confidence scoring, dry-run, git detection) for 1% adoption. The "agent cleans memory while you sleep" fantasy isn't worth the cost.

## Why these cuts

User feedback (m0069): *"we lost the plot, got lost in technical improvements instead of features."*

v7 tried to ship a 15-plugin DLC suite with heavy emphasis on:
- DLC pattern rules
- Flag-file coordination
- Hook ordering
- Plugin slot arithmetic
- Multi-threshold token events
- Bundle-patch workarounds

All of that is **infrastructure for infrastructure's sake**. v8 ships 5 v7 survivors + 3 MiMo-Code ports lib-1 found we missed entirely. Each v8 feature is a real user-visible benefit, not plumbing.

## How features were chosen

| Source | What we got | Why |
|--------|-------------|-----|
| Council round 5 (re-prioritize) | F1, F2, F4', F7, Auto-Max | Re-ranked by user-value vs engineering cost |
| Lib-1 MiMo-Code patches/ re-look | Dynamic Workflow, Verify skill, Compose pack | The blog's killer features we missed for 5 rounds |
| Council round 5 (kill list) | F3+ Health, F8 Dream | Engineering-for-engineering, no user value |
| Council round 5 (defer list) | F5' Checkpoint, F6' Judge | Real but rare, cost outweighs value for v8.0 |

## Ship order (proposed, updated post-re-look)

| Week | Features | Effort |
|------|----------|--------|
| W1 | F4' Memory + Context Recon + F2 Rules + OpenCode-migration README | 20-27h |
| W2 | F1 Watchdog + EOS stripper + log whitelist | 14-18h |
| W3 | F7 Max Mode + Auto-Max triggers | 12-16h |
| W4 | Compose pack + Verify skill + "Import from MiMo" guide | 4-6h |
| W5-6 | Dynamic Workflow (sandbox + JS primitives) | 25-35h |
| W7 | Buffer, integration, Git publication prep | — |

**Total**: ~80-105h, 7 weeks full-time.

## Round 6 Re-Look (2026-06-14, post-web-research)

User explicitly demanded broader web research. lib-1 fetched 5 user-provided URLs + 4 keyword searches → 15 new references. Council re-evaluated v8.

### Must-add (integrated into ship order)

| Name | Week | Owner | Effort | Risk if missing |
|---|---|---|---|---|
| **OpenCode-migration README** | W1 (docs) | docs | 2-3h | 5+ OpenCode-migration issues/day on MiMo-Code. They bounce to agentmemory. |
| **EOS token stripper** | W2 | safety | 4-6h | Local model users (Ollama/vLLM/oMLX) hit agent-loop death after 1 tool call. |
| **Log whitelist** | W2 | safety | 2h | 12GB log files in 30 days from permission-log spam. |
| **200K threshold calibration** | v8.0.1 (advisory) | memory | 2h | Compaction triggers fire wrong at wrong moment. |
| **"Import from MiMo" guide** | W4 | docs | 2h | 8,210 MiMo-Code stars = huge pool of users who don't know we're a port. |
| **Max Mode marketing line** | W1 (README) | docs | 0.5h | "10-20% SWE-Bench Pro at 4-5x cost" is the best copy. |

### Must-change (audited)

- v8 README leads with **"Import from OpenCode in 5 minutes"**
- All context-window claims → **200K, not 1M** (upstream bug)
- All docs → **no voice control claim** (issue #472 contradicts)
- All docs → **no macOS support claim** (issue #607 IPC bug)
- F4' Memory thresholds: **40/80% → 20/45/70%** (200K window needs earlier compaction; advisory for v8.0.1)
- F2 Rules log: **whitelist decisions only** (don't repeat 12GB log spam)
- F7 Max Mode README: include **"10-20% SWE-Bench Pro at 4-5x cost" verbatim**
- 82/62/73 (MiMo+V2.5-Pro) vs 79/55/69 (Claude Code+Sonnet 4.6) benchmark line
- 200-step task template in W4 docs ("clone → update libs → refactor → test → open PR")

**Net effort: ~10h across W1 (docs), W2 (code), v8.0.1 (in-flight patches). No week slips.**

### Must-not

- **Don't promise voice control.** Issue #472 contradicts.
- **Don't claim macOS support.** Issue #607 IPC bug. Linux-only is honest.
- **Don't claim 1M context window.** Upstream bug. 200K is truth.
- **Don't market to Claude Code users.** Focus on OpenCode migrators — that's our wedge.
- **Don't ship more than 5 plugins in v8.0.** Already at complexity ceiling.
- **Don't include benchmarks you can't reproduce.** Cite MiMo's published numbers, don't re-run.
- **Don't promise SLAs.** Personal project. No 24h support claim.
- **Don't bundle deps that need macOS testing.** Anything macOS-unsafe goes to v8.1+.

### Competitive response

| Competitor | Strength | Weakness | Our moat |
|---|---|---|---|
| **agentmemory** (rohitg00) | Codex + Claude Code plugins, 53 MCP tools | OpenCode is third-class | **OpenCode-native.** We ARE the OpenCode port. |
| **mimo2codex** (7as0nch, 584★) | MiMo-V2.5/DeepSeek V4 Pro behind Codex CLI | Single harness, no plugin system | **Model-agnostic on OpenCode.** No extra binary. |
| **MiMo-Code** (upstream) | The original. 8,210 stars. | 533 open issues, rotting | **Focused 5-plugin subset.** Less surface = less to rot. |

**Wedge:** "the OpenCode port that ships the 5 features that matter and stops trying to be a second harness."

### The ONE thing v8 should fear

**The window closes before we ship.**

8,210 stars in 4 days. agentmemory exists. mimo2codex has 584 stars. Mid-July 2026 is the deadline. If W2 or W3 slips, **cut W4 Compose pack to ship W3 earlier**. 5 features shipped on time > 8 features shipped late.

## Reference (curated to 7)

1. **agentmemory** (rohitg00/agentmemory) — direct competitor, ships Codex + Claude Code plugins
2. **mimo2codex** (7as0nch/mimo2codex, 584 stars) — demand signal, MiMo engine on user-preferred harness
3. **MiMo-Code** (XiaomiMiMo/MiMo-Code) — upstream we're porting from
4. **MiMo-V2.5-Pro pricing** — $1.00/$3.00 per M tokens (≤256K), $0.20-$0.40 cache hits. Cheapest frontier.
5. **SWE-Bench Pro comparison** — 82/62/73 (MiMo+V2.5-Pro) vs 79/55/69 (Claude Code+Sonnet 4.6). Harness accounts for ~5pp.
6. **MiMo-Code PR #603** — EOS token stripping (7 regex patterns for local models)
7. **MiMo-Code PR #604** — permission log spam (12GB files); we must whitelist

### See also (not in main references)

- DeveloperTech 200-step task template (clone → update → refactor → test → PR)
- MiMo-Code issues #565/#567/#569/#585/#588 (OpenCode migrator feature requests)
- MiMo-Code issue #472 (voice control contradiction)
- MiMo-Code issue #607 (macOS IPC bug)
- Ken Huang "Why AI Agents Are Starting to Dream" (copy-on-write dream design)
- Daily.dev summary (third-party mention of 20/45/70% trigger thresholds)
- mimo.xiaomi.com/mimocode/start (official docs)
- VentureBeat article (the contractor/architect writer subagent metaphor)
- kod.ru review (Russian coverage)
- Shengyayun (Chinese confirmation of single-writer rule)
- Reddit r/AIGuild thread
- Hacker News thread
- Homebrew formula
