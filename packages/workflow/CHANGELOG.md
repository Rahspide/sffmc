# @sffmc/workflow Changelog

## 0.1.0 — Foundation layer

- **types.ts**: 12 exported types and 1 WorkflowError class — WorkflowRun, WorkflowStep, JournalEvent, RunEntry, WorkflowConfig, SandboxConstraints, AgentOptions, AgentResult, AgentFailureReason, WorkflowStatus, WorkflowStartInput, WorkflowStatusOutput, WorkflowOutcome
- **schema.ts**: workflow_runs + workflow_steps tables with indices, WAL mode auto-applied
- **persistence.ts**: 3-layer state (SQLite row + script file + JSONL journal) — createRun, loadRun, updateRunStatus, writeScript, readScript, appendJournalSync, appendJournal, loadJournal, clearJournal, checkpointStep, loadCompletedSteps, computeScriptSha, journalKey, journalKeyBase, generateRunID, listRuns. Separate DB at `$XDG_DATA_HOME/SFFMC/workflow/state.sqlite`
- **workspace.ts**: file primitives with lexical jail — readFile, writeFile, exists, glob, setJail, resolveInWorkspace
- **events.ts**: 6 bus events (started, agent_failed, phase, log, finished, step_checkpoint) — Map-based, no external deps
- **meta.ts**: bracket-counting meta parser — no eval(), recursive-descent reader for JS object literals, supports comments, handles escape sequences
- **resolve.ts**: saved/inline/file workflow resolver — walks up directory tree for `.sffmc/workflows/` and `.claude/workflows/`
- **runtime-ref.ts**: late-bound runtime ref — breaks circular import between tool.ts and runtime.ts
- **builtin-registry.ts**: built-in workflow registry — initially empty, Lane D will register deep-research

Total: 1,907 LOC across 13 files. 50 tests.
