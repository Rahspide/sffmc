---
name: agentic:compose-skill
description: "Use when the task is multi-step and benefits from reading existing markdown skills. The compose_skill tool reads 18 pre-loaded skills from packages/compose/skills/ (ask, plan, execute, parallel, etc.). Reads skill by name, returns markdown content into context."
hidden: true
---

# Reading Compose Skills

## The Rule

Before starting a non-trivial task, scan the 18 compose skills. If one matches, read it via `compose_skill({ name: "compose:<name>" })` to get its guidance. Don't re-derive what a skill already says — that wastes context and produces inconsistent output.

## The 18 Skills (Mental Index)

| Skill | When to read |
|---|---|
| `ask` | How to ask the user, never-ask fallback |
| `plan` | Multi-step planning |
| `execute` | Single-step execution patterns |
| `parallel` | When to use parallel sub-agents |
| `subagent` | How to spawn sub-agents |
| `tdd` | Red-green-refactor |
| `debug` | Debugging methodology |
| `verify` | Post-task verification |
| `review` | Code review patterns |
| `merge` | Git merge strategies |
| `worktree` | Git worktree usage |
| `report` | Final report structure |
| `feedback` | User feedback handling |
| `brainstorm` | Multi-option ideation |
| `new-skill` | How to write a new skill |
| `code-review` | Formal code review |
| `audit-deps` | Dependency audit |
| `benchmark` | Performance benchmarking |

## Tool Call

```
compose_skill({ name: "compose:plan" })
// Returns the markdown content of compose/skills/plan.md
```

## Skill Chaining

Most tasks use 3-5 skills in sequence. Example: "refactor a module" → `plan` → `tdd` → `execute` → `verify` → `review`. Read each as you go — don't preload all 18. Preloading wastes context on irrelevant rules.

## When to Skip compose_skill

- Task is **fewer than 5 tool calls** — overhead exceeds benefit
- You **already know** the skill's content — don't reread
- The user gave **very specific instructions** — the skill might conflict with their direct guidance
- The task is a **one-shot tool call** — e.g., "search this file for 'TODO'"

## Examples

- "Refactor this module" → read `compose:plan` first, then `compose:tdd`, then `compose:review`
- "Why is this test failing?" → read `compose:debug`
- "I need to decide between X and Y" → read `compose:brainstorm` and `compose:ask`
- "Write a report on what we did" → read `compose:report`

## Why This Skill Exists

The 18 skills encode SFFMC-specific patterns refined over time. Without this index, the LLM reinvents them (often worse) or ignores them entirely. This skill is the gateway — read it once to know what exists, then pull specific skills on demand.
