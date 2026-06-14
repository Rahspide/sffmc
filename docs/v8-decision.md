# v8 Decision

## Status

**v8.0.0 — all 8 features confirmed by user on 2026-06-14.** W1 starting.

| Week | Features | Effort |
|------|----------|--------|
| W1 | F4' Memory + F2 Rules | 18-24h |
| W2 | F1 Watchdog + Verify skill | 8-12h |
| W3 | F7 Max Mode + Auto-Max triggers | 12-16h |
| W4 | Compose pack | 2-4h |
| W5-6 | Dynamic Workflow | 25-35h |
| W7 | Buffer, integration, Git publication | — |

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

## Ship order (proposed)

| Week | Features | Effort |
|------|----------|--------|
| W1 | F4' Memory + Context Recon + F2 Rules | 18-24h |
| W2 | F1 Watchdog + Verify skill | 8-12h |
| W3 | F7 Max Mode + Auto-Max triggers | 12-16h |
| W4 | Compose pack (15 skills verbatim) | 2-4h |
| W5-6 | Dynamic Workflow (sandbox + JS primitives) | 25-35h |
| W7 | Buffer, integration, Git publication prep | — |

**Total**: ~70-95h, 7 weeks full-time.

## Reference

- **MiMo-Code**: https://github.com/XiaomiMiMo/MiMo-Code
- **OpenCode**: https://github.com/anomalyco/opencode
- **MiMo-Code blog**: https://mimo.xiaomi.com/zh/blog/mimo-code-long-horizon
- **Habr summary**: https://habr.com/ru/companies/selectel/news/1046660/
