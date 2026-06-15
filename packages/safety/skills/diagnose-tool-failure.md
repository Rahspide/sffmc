---
name: safety:diagnose-tool-failure
description: "Use when a tool has failed 2+ times in the current session. Read the watchdog verdict (output of `error_class_filter` match) and decide: retry with adjusted params, escalate to max-mode via auto-max, or surface the error to the user. Covers the 3-failure threshold, the rolling 10-call window, and the /max escape hatch."
hidden: true
---

# Diagnosing Tool Failures

## The Rule

When a tool returns an error 2+ times, switch from "execute the next call" to "diagnose the failure pattern." Read the watchdog's FailureCounter state or recent error outputs. Do not retry blindly — every retry after the second must be informed by the verdict.

## The 3-Failure Threshold

Watchdog triggers a recovery verdict after **3 failures within 10 calls** (rolling window). The verdict is one of:

| Verdict | Meaning |
|---|---|
| `retry` | Transient — same params, just try again. |
| `promote` | Switch to `promote_model` (default `ocg/deepseek-v4-flash`). |
| `escalate` | Recommend user invoke `/max` for parallel attempts. |
| `surface` | Give up — tell the user what failed and why. |

## How to Read the Verdict

The watchdog plugin logs the verdict via `console.warn` prefixed with `[watchdog]`. Look for:

```
[watchdog] verdict: <type> for tool <name>
```

Match the error class against known filter categories: `fetch_429`, `playwright_timeout`, `EAGAIN`, `ENOENT`, `EACCES`, `EPERM`, `ECONNREFUSED`, etc.

## Examples

Tool fails with `fetch_429` 3 times:
→ watchdog verdict: `promote`
→ Next call should use `promote_model`, OR suggest `/max`.

Tool fails with `ENOENT` 3 times:
→ watchdog verdict: `surface`
→ Tell user: "File not found after 3 attempts. Check path."

Tool fails with `ECONNREFUSED` 3 times:
→ watchdog verdict: `escalate`
→ Propose `/max` to the user.

## When to Invoke /max

If verdict is `escalate`, propose: "Tool X keeps failing. Run /max to try 3 parallel candidates with a judge model?" User must approve — `/max` is a command, not a tool call you can make silently.

## When Not to Invoke /max

- The failure is **deterministic** (e.g., file doesn't exist — no parallel candidate will find it).
- The error is **transient** (429 rate limit) — wait, don't escalate.
- Verdict is `surface` — the system has already given up; surface to user.

## Why This Skill Exists

Without it, the LLM retries the same failing call indefinitely or hallucinates fixes. Watchdog is the authoritative arbiter; consult it before improvising.
