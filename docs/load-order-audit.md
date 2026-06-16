# SFFMC Load Order Audit (v0.6.0 — historical, see CHANGELOG)

**Date**: 2026-06-15
**Scope**: 9 SFFMC plugins loaded in sandbox config, 13 external plugins (slim, DCP, wrappers, icm, etc.)
**Method**: AST-based extraction of hook keys from `server()` return blocks
**Result**: **No conflicts** — all multi-listener registrations are intentional and OpenCode handles them in plugin load order

## Load order (W1 → W6 chronological)

| Slot | Plugin | Hooks registered |
|---|---|---|
| 13 | @sffmc/memory | `config`, `event`, `experimental.chat.messages.transform` |
| 14 | @sffmc/rules | `tool.execute.before`, `permission.ask` |
| 15 | @sffmc/watchdog | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform`, `experimental.chat.messages.transform`, `command.execute.before` |
| 16 | @sffmc/eos-stripper | `config`, `experimental.text.complete` |
| 17 | @sffmc/log-whitelist | `config`, `tool.execute.after`, `experimental.text.complete` |
| 18 | @sffmc/max-mode | `config`, `command.execute.before`, `experimental.chat.system.transform`, `tool.execute.before`, `experimental.chat.messages.transform` |
| 19 | @sffmc/auto-max | `config`, `event`, `tool.execute.after`, `experimental.chat.system.transform` |
| 20 | @sffmc/compose | `tool` (compose_skill) |
| 21 | @sffmc/workflow | `config`, `tool` (workflow) |

## Tool name audit

| Tool | Plugin | External conflict? |
|---|---|---|
| `compose_skill` | @sffmc/compose | ✓ none |
| `workflow` | @sffmc/workflow | ✓ none |

## Hook multi-registration analysis

All multi-registrations are intentional. OpenCode runs them in plugin load order. No two plugins attempt to "own" the same hook — they all ADD a listener.

| Hook | Plugins | Load order | Purpose |
|---|---|---|---|
| `config` | 7 plugins | memory → ... → workflow | Startup init (independent) |
| `event` | memory, watchdog, auto-max | 13, 15, 19 | Session lifecycle listeners (parallel) |
| `tool.execute.before` | rules, max-mode | 14, 18 | Pre-execution gates (rules denies, then max-mode parallel drafts) |
| `tool.execute.after` | watchdog, log-whitelist, auto-max | 15, 17, 19 | Post-execution: watchdog detects failure, log-whitelist cleans output, auto-max escalates |
| `tool` | compose, workflow | 20, 21 | Tool registration (distinct names) |
| `command.execute.before` | watchdog, max-mode | 15, 18 | `/max` command: watchdog resets, then max-mode activates |
| `experimental.chat.system.transform` | watchdog, max-mode, auto-max | 15, 18, 19 | All push fragments (additive) |
| `experimental.chat.messages.transform` | memory, watchdog, max-mode | 13, 15, 18 | All transform (additive) |
| `experimental.text.complete` | eos-stripper, log-whitelist | 16, 17 | EOS strip first, then whitelist filter |
| `permission.ask` | rules | 14 | (single) |

## Critical order verifications

### /max command flow
1. Slot 14 (rules) `permission.ask` — checks rules config
2. Slot 15 (watchdog) `command.execute.before` — `/max` → reset all counters
3. Slot 18 (max-mode) `command.execute.before` — `/max` → activate max-mode
**Order: reset BEFORE activate ✓**

### Output post-processing (after tool call)
1. Slot 15 (watchdog) `tool.execute.after` — detect failure, may inject recovery verdict
2. Slot 17 (log-whitelist) `tool.execute.after` — apply whitelist filter to output
3. Slot 19 (auto-max) `tool.execute.after` — check escalation triggers
**Order: failure detection → filter → escalation ✓**

### System prompt composition
1. Slot 15 (watchdog) — promote fragment (if session promoted)
2. Slot 18 (max-mode) — max-mode instructions
3. Slot 19 (auto-max) — auto-escalation hint
**Order: all additive ✓**

### Text completion (LLM output)
1. Slot 16 (eos-stripper) `experimental.text.complete` — strip EOS tokens
2. Slot 17 (log-whitelist) `experimental.text.complete` — filter logs
**Order: EOS first (keeps readable), then filter ✓**

## External plugin overlap check

This section documents how SFFMC plugins interact with the standard OpenCode plugin ecosystem. Specific third-party plugin names are out of scope for public docs; consult the maintainer runbook for details.

| Hook | SFFMC-only? | Conflict? |
|---|---|---|
| `config` | yes | ✓ all init is independent |
| `event` | yes | ✓ expected |
| `tool.execute.before` | yes | (no functional conflict — different roles) |
| `tool.execute.after` | yes | (output transforms — order matters) |
| `experimental.chat.system.transform` | yes | (additive with SFFMC) |
| `experimental.text.complete` | yes | ⚠ order-sensitive — eos-stripper+log-whitelist must run before any output-pruning transforms. Not a bug today. |

## Cross-stack load order

SFFMC plugins load in a deterministic order (composites first, then sub-features). This means:
- Composite packages (`@sffmc/safety`, `@sffmc/memory`, `@sffmc/agentic`) register their composed hooks before any individual sub-feature re-registers.
- Sub-features can rely on shared SDK (config loading, event bus) being available.
- No "race condition" where a SFFMC plugin runs before a dependency.

## Findings: zero blocking issues

1. **No tool name conflicts** (compose_skill, workflow — both SFFMC-only)
2. **No hook ownership conflicts** (all multi-registrations are intentional listeners)
3. **Plugin load order is correct** (chronological W1→W6, SFFMC after external deps)
4. **Critical sequencing verified** (/max reset before activate, watchdog before log-whitelist, etc.)
5. **External hook overlap is non-conflicting** (additive, not replacing)

## Minor observations (not blockers)

- `experimental.text.complete` is registered by 2 SFFMC plugins (eos-stripper, log-whitelist) + 1 external (dcp-strip-malformed). If DCP's regex matches patterns our filters already cleaned, that's wasted work — but not a bug.
- `tool.execute.after` has 3 SFFMC + ~3 external handlers. Output is mutated 6 times. If any external plugin REPLACES (not appends) the output, our post-processing is lost. Not observed in v0.6.0 *(historical — the audit was run against v0.6.0; no replacement-observed issue through v0.9.0)*.
- `permission.ask` from rules (slot 14) runs before external `permission.ask` (slim). Slim has a final say. If slim denies, our allow becomes noise. Currently rules gates a curated subset (no overlap with slim denies). **Audit note (v0.6.0 — historical)**: the findings below are from the v0.6.0 audit and remain valid for v0.9.0.

## Recommendation

**Ship v0.6.0 with this load order unchanged.** The order is intentional and verified. No reordering needed. *(This was the v0.6.0 recommendation — the load order shipped unchanged through v0.9.0.)*

For v0.10.0+:
- Add a `SFFMC_LOAD_ORDER.md` doc to repo (this file as starting point)
- Add a CI check: parse each plugin's hooks, fail if any tool name conflicts
- Consider reordering if a new plugin needs to fire before an existing one
