---
name: agentic:run-max-mode
description: "Use when the task has multiple valid approaches with subjective tradeoffs, or when 2-5 parallel attempts would help. Runs max-mode: 3 parallel candidate generators + 1 judge. Cost is 3-5x normal. Triggered via /max or auto-max safety valve."
hidden: true
---

# Running Max-Mode (Parallel Candidates + Judge)

## The Rule

Max-mode is expensive (3-5x tokens) but useful for hard problems. Suggest it when:

- The user asks "what's the best way to X?"
- 2+ approaches have real tradeoffs
- A single attempt has already failed (see `safety:manage-auto-max`)

Do **not** suggest max-mode for known-fact questions, trivial choices, or when budget is explicitly constrained.

## Two Entry Points

- **Manual** — user types `/max` in chat. The `command.execute.before` hook intercepts `/max` and triggers max-mode for the next turn.
- **Auto** — `safety:auto-max` triggers when the watchdog verdict is `escalate`. Silent — no user action required. Announce it: "Auto-max triggered due to repeated failures. Switching to /max."

## What Max-Mode Does

1. Generate 3 candidate responses in parallel (3 different `candidate_models` or same model with different temperatures)
2. Strip tool executes from candidates (only judge the prose)
3. Judge all 3 with `judge_model` (default `ocg/deepseek-v4-flash`)
4. Pick the winner, restore tool executes, return

## Configuration (`~/.config/SFFMC/max-mode.yaml`)

```yaml
n_candidates: 3                  # default
candidate_models: []             # empty = use current model
candidate_temperature: 1.0       # default
judge_model: "ocg/deepseek-v4-flash"
budget_cap_multiplier: 5         # hard cap on cost
dry_run: false                   # if true, generate but don't judge
```

## When to Use Max-Mode

- Architecture decisions ("should we use Postgres or SQLite?")
- Algorithm choices ("DFS vs BFS for this graph?")
- Code variants that are all "correct" but differ in style or performance
- First-time exploration of a problem space

## When NOT to Use Max-Mode

- The answer is a known fact (just look it up)
- You have budget concerns (use single-shot)
- The candidates would all be identical — no diversity possible
- The task is a single correct path (e.g., "fix this one-line typo")

## Cost-Aware Prompts

- "I could try 3 approaches in parallel — want me to?" — ask the user
- "Auto-max triggered due to repeated failures. Switching to /max." — system message
- Never invoke max-mode silently without a trigger

## Why This Skill Exists

Max-mode is the "expensive but high-quality" path. Without this skill, the LLM either never reaches for it (stuck on hard problems) or reaches too often (cost blowup). This skill sets the boundary.
