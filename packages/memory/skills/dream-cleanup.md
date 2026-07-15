---
name: memory:dream-cleanup
description: "Use when the memory DB is large (>10MB), when stale memories are being recalled, or when the user explicitly asks for cleanup. Runs extra_dream: deduplicates via Jaccard similarity, removes stale memory >30d, clusters and summarizes similar memories. Runs automatically via cron or on-demand."
hidden: true
---

# Dream Cleanup

## The Rule

Dream is maintenance, not retrieval. It runs in the background every 24 hours via cron (default), but can also be invoked manually. Do NOT call it during an active task - it reads and writes the same SQLite database and takes 5-30 seconds. Call it between sessions or during idle.

## What Dream Does (3 Phases)

1. **Dedup** - finds memory pairs with Jaccard similarity > 0.9 and merges them, keeping the higher-importance entry
2. **Stale removal** - memories older than 30 days with importance < 0.2 are archived (moved to `dream-archive.jsonl`, not deleted)
3. **Cluster summarization** - groups 5+ similar memories into clusters and summarizes each cluster into a single representative memory

## Tool Call

```
extra_dream({
  dry_run: false,
})
```

Returns: `{ scanned: 120, deduped: 8, archived: 4, summarized: 2, durationMs: 3400, ok: true }`.

Pass `dry_run: true` to preview what would happen without mutating the database.

Triggers automatically when memory count exceeds `dream_threshold` (default 50) or every `dream_interval_hours` (default 24).

## Cluster Naming

When dream summarizes a cluster, it stores the cluster name in the representative memory's metadata section. The name is derived from the cluster's common topic (e.g., "opencode migration", "MCP config pattern"). Cluster naming via LLM is not exposed as a separate parameter - it is always on when summarization runs.

## Restore

Archived memories are NOT deleted. They live in `~/.local/share/SFFMC/memory/dream-archive.jsonl`. To restore a specific cluster or set of memories, you must read the archive file with file tools and manually re-insert entries. There is no auto-restore tool at this time.

## When to Run Manually

- User says "memory is bloated" or "I'm getting weird recalls"
- Before a major project change (clean slate for the new phase)
- After a burst of auto-generated memories (e.g., 100+ in a single day)
- After deleting or renaming many files that memory entries reference

## Pitfalls

- Don't run while the session is active - dream reads and writes the same SQLite database
- Archive is append-only (`dream-archive.jsonl`). It grows monotonically; periodically delete old archive lines if disk is tight
- Jaccard dedup is aggressive at 0.9 threshold - near-identical memories WILL be merged. This is by design

## Why This Skill Exists

Memory databases grow monotonically. Without periodic cleanup, the LLM gets worse over time: stale recalls dilute the recon, duplicates waste budget, and dead references confuse. Dream is controlled forgetting - clean what's noise, keep what's signal.
