---
name: memory:checkpoint-save
description: "Use when the current task is >20 tool calls, when the session is getting long, or before a risky operation (large refactor, migration). Saves a checkpoint via extra_checkpoint - 200K token resume point stored at ~/.local/share/sffmc/extra/checkpoints/."
hidden: true
---

# Checkpoint Save

## The Rule

Save a checkpoint at natural breakpoints, not just before a crash. A checkpoint is a full snapshot of: message history, current tool state, recon context, and session ID. Resume restores all four. Saving takes 5-10 seconds of serialization - budget accordingly.

## When to Save

Three triggers:

1. **Long task** - every 20-30 tool calls. Don't wait until you feel the session is "too long"; checkpoint at phase boundaries.
2. **Risky op** - before `rm -rf`, `git reset --hard`, large migrations, or any operation where rollback is expensive.
3. **Context switch** - before pivoting from one sub-task to another. The checkpoint is a clean anchor point.

## Tool Call

`extra_checkpoint` is exposed as a tool with three actions: `list`, `save` (the default - no action needed), and `restore`. To save:

```
extra_checkpoint({
  action: "save",
  sessionID: "<current-session-id>",
})
```

Returns: `{ id, name, size_bytes, saved_at }`.

## Restore

On resume, the latest checkpoint (by `saved_at`) is auto-injected into the recon via the checkpoint budget slot. To restore a specific checkpoint manually:

```
extra_checkpoint({
  action: "restore",
  sessionID: "<session-id>",
})
```

Or to list available checkpoints:

```
extra_checkpoint({ action: "list" })
```

You can also inject the auto-restore directive in a message: `<!-- EXTRA_RESTORE: <sessionID> -->`.

## Schema Versioning

Checkpoints are schema-versioned. Current version is v1 (raw messages). Future v2+ may include compressed diffs with smaller payload size.

## Pitfalls

- Saving takes 5-10 seconds - do NOT save inside a tight loop. One save per task phase, not per call.
- Storage path: `~/.local/share/sffmc/extra/checkpoints/<session-id>/<name>.json.gz`.
- Checkpoints are gzip-compressed JSON. A 200K-token session produces ~1-3 MB on disk.
- Delete old checkpoints with `extra_checkpoint({ action: "delete", sessionID: "<id>" })` to free space.

## Why This Skill Exists

Long tasks (50+ tool calls) lose context to token limits. A checkpoint is a resume point - no re-work, no lost state, no second-guessing what was done.
