---
name: memory:recall
description: "Use when starting a new session, switching projects, or when the user asks 'what did we work on last time'. Recalls top memories by importance, shows the recon injected at session start, and explains the 5 budget categories (memory/checkpoint/taskTree/tail/agents)."
hidden: true
---

# Memory Recall

## The Rule

At session start, the memory plugin auto-injects a recon summary into the system prompt via `experimental.chat.messages.transform`. The recon is the project's "remembered" state - top memories, AGENTS.md, recent chat tail, task tree, and checkpoint. You DO NOT need to call a tool to use it - it is already in your context, prefixed with `[Context Recon 8K - injected by @sffmc/memory]`.

If the user asks "what did we work on last time?" or you are switching projects, read the recon first. Only force a re-recall when the recon is clearly stale.

## 5 Budget Categories

Configured in `~/.config/SFFMC/memory.yaml` under `recon_budgets`:

1. **memory** (6144 tokens) - top memories by importance, sourced from `memory-bank/`, `AGENTS.md`, and `*.md` files
2. **checkpoint** (6144 tokens) - latest checkpoint state (see `memory:checkpoint-save`)
3. **taskTree** (4096 tokens) - open tasks extracted from `*.md` files in `memory-bank/`
4. **tail** (8192 tokens) - last 8K characters of recent chat messages
5. **agents** (8192 tokens) - AGENTS.md content

Each budget is a hard character limit. The recon truncates sections that exceed their budget, appending `[...truncated]`.

## How to Read the Injected Recon

The recon is the first system message in the prompt. It starts with:

```
[Context Recon 8K - injected by @sffmc/memory]
```

The recon has 5 sections, each heading is a `##` markdown line: `## Memory`, `## Checkpoint`, `## Task Tree`, `## Recent Context`, `## AGENTS.md`. Look for these before asking "what was the last task?" - the answer is likely already there.

## Force Re-Recall

If the user says "no, I mean the previous version" or you suspect the recon is stale, there is no inline tool to call - the recon is injected once per session. You must either:

1. End the current session and start a new one (the recon is regenerated fresh).
2. Read `memory-bank/` files directly with file tools if you need granular history.

## When Memories Are Stale

If a recalled memory references deleted files, renamed directories, or code that no longer exists, ask: "Should I run dream cleanup?" (see `memory:dream-cleanup`). Stale memories dilute the recon and waste tokens.

## Why This Skill Exists

Without it, the LLM re-asks questions whose answers are already in the injected recon. Wastes 5K+ tokens and 1-2 turns per session.
