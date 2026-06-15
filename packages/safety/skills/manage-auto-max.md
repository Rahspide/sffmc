---
name: safety:manage-auto-max
description: "Use when tool failures are cascading or the user asks about /max. Explains when auto-max triggers (3+ failures, watchdog verdict: escalate), how /max escape hatch resets counters, and the difference between auto-max and manual /max."
hidden: true
---

# Managing Auto-Max and /max

## The Rule

Auto-max is a **safety valve**, not a normal tool. It triggers automatically when the watchdog verdict is `escalate`. The user does NOT need to invoke it manually; the system does. If you see repeated failures, suggest `/max` as a recovery option.

## Two Modes

| Mode | Trigger | Cost | When |
|---|---|---|---|
| auto-max | Watchdog verdict: `escalate` | 3–5× tokens | Silent, internal recovery |
| `/max` (manual) | User types `/max` | Same | Explicit user request |

## How /max Escape Hatch Works

User types `/max` in chat. The `command.execute.before` hook in safety matches `/max`, resets the watchdog counter and auto-max trigger, then continues normal execution. This is a "fresh start" mechanism.

## How Auto-Max Triggers

Auto-max listens to `tool.execute.after` events. When the watchdog's FailureCounter reaches threshold AND verdict is `escalate`, auto-max:

1. Generates 3 candidate responses in parallel
2. Calls the judge model (default `ocg/deepseek-v4-flash`) to pick the best
3. Replaces the failing call's continuation with the winning candidate
4. User sees: `[auto-max] escalated to max-mode for tool X`

## When to Suggest /max to the User

- Tool failed 3+ times with no recovery verdict
- User explicitly asks "try harder" or "different approach"
- User has budget for 3–5× token cost

## When NOT to Suggest /max

- The failure is **deterministic** (e.g., file doesn't exist — retrying won't help)
- User is on a **tight budget** (auto-max is 3–5× cost)
- The error is **transient** (429 rate limit) — wait, don't escalate

## Examples

- Bash fails with "permission denied" 3 times → suggest `/max` (different approach may work)
- Curl 429s 3 times → DON'T suggest `/max`, instead suggest "wait 30s and retry"
- Grep returns no results 3 times → suggest `/max` (search may need different terms)

## Why This Skill Exists

Auto-max is silent and rare. Users don't know it exists. Without this skill, the LLM either escalates to `/max` too eagerly (cost blowup) or never suggests it (user stuck).
