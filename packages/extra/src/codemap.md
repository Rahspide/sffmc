# packages/extra/src/ — Source Files

## Responsibility

Implementation of the `@sffmc/extra` OpenCode plugin. Contains 3 independent factory modules (checkpoint, judge, dream), the plugin entry point that wires them together via the factory+spread pattern, and the test suite. Each factory module is self-contained and exposes a `{ tool, hooks }` return shape for consumption by `index.ts`.

## Files

| File | Purpose |
|---|---|
| `index.ts` | Plugin entry point. Loads config via `@sffmc/shared`, calls 3 factories (`createCheckpointTool`, `createJudgeTool`, `createDreamTool`), spreads hooks into top-level return, nests tools under `"tool"`. Exports `ExtraConfig` interface and `default` plugin module. 81 lines. |
| `checkpoint.ts` | F5' Checkpoint — session state capture, JSONL persistence, restore via marker injection. Factory: `createCheckpointTool({ enabled })`. Wires `tool.execute.after` (auto-capture) and `experimental.chat.messages.transform` (auto-restore) hooks. Exports `ToolCall`, `CheckpointState`, `CheckpointTool`, `CheckpointHooks`, and test helpers (`__setCheckpointDir`, `__cleanup`, `filePath`, `readToolCalls`, `listSessions`, `flushSession`, `flushAll`). 442 lines. |
| `judge.ts` | F6' Judge — multi-criteria LLM scoring of 2-8 candidates. Factory: `createJudgeTool({ enabled, model, rubric, judge_auto, ctx })`. Builds structured prompts, calls LLM via `ctx.client.session.message()`, parses JSON responses, validates scores 0-10. Falls back to length-based heuristic when no LLM client available. Wires `experimental.chat.messages.transform` hook for auto-judge (opt-in via `judge_auto`). Exports `JudgeConfig`, `JudgeTool`, `JudgeHooks`, `JudgeInput`, `JudgeResult`, `JudgeError`, `JudgeSkipped`, `JudgeScore`, `buildJudgePrompt`, `parseJudgeResponse`, `extractCandidatesFromMessages`. 409 lines. |
| `dream.ts` | F8 Dream — background memory-cleaning service. Factory: `createDreamTool({ enabled, threshold, intervalHours, storagePath? })`. Opens SQLite DB (`bun:sqlite`), runs 4-phase cycle: dedup (Jaccard > 0.9), stale removal (>30d), greedy clustering (Jaccard > 0.3), summarization (clusters of 5+ → concat summary). Wires `tool.execute.after` hook for count-threshold auto-trigger. Starts `setInterval` cron timer. Concurrency-locked via module-level `dreamLock` Promise. Exports `DreamConfig`, `DreamTool`, `DreamHooks`, `DreamResult`, `clearCronTimer`, `isDreamLocked`. 468 lines. |
| `index.test.ts` | 4 tests covering plugin shape verification: default export `{ id, server }` identity, 3-tool registration with no `name` field (fix-17 regression guard), disabled-stub behavior (`{ skipped: true }` returns), and factory function return shapes (`{ tool, hooks }`). 87 lines. |

## Key Design Notes

### index.ts — factory spread pattern, no tool `name` field

- Each factory returns `{ tool, hooks }`. Hooks are spread at the top level (`...checkpoint.hooks, ...judge.hooks, ...dream.hooks`) so OpenCode registers them as plugin hooks. Tools are nested under `tool: { extra_checkpoint, extra_judge, extra_dream }`.
- The tool key IS the name — no `name` field on any tool definition. This follows the DLC pattern established by fix-17: the `tool` object's keys are the tool names OpenCode uses for routing. The test suite verifies `tool.name === undefined` as a regression guard.
- Config is loaded once via `loadConfig<ExtraConfig>("extra", defaultConfig)` and distributed to factories as narrowed config slices. Each factory receives only the fields it needs (e.g., checkpoint receives `{ enabled }`, judge receives `{ enabled, model, rubric, judge_auto, ctx }`).
- The `console.log` on line 46 provides a single-line startup confirmation showing which features are enabled. Useful for debugging which hooks are active.

### checkpoint.ts — JSONL capture/restore with schema versioning

- **Storage model**: per-session JSONL files at `~/.local/share/sffmc/extra/checkpoints/<sessionID>.jsonl`. First line is a header record (`__type: "header"`) containing sessionID, version, timestamps. Subsequent lines are `ToolCall` records. This is append-only — never re-written, only created, appended, or deleted.
- **In-memory buffer**: `sessionBuffers` (Map<string, ToolCall[]>) accumulates calls. Flush triggers: (a) buffer reaches `FLUSH_THRESHOLD` (50 calls), or (b) `FLUSH_INTERVAL_MS` (5s) periodic timer. The timer is `unref()`'d so it doesn't keep the process alive. Buffers are cleared after flush (`buf.length = 0`).
- **`tool.execute.after` hook** — captures every tool call result. Receives `{ tool, sessionID, callID }` context and `{ output, title, metadata }` result. Constructs a `ToolCall` record with timestamp. Pushes to the in-memory buffer for that session. This hook is the primary data ingestion path — all tool calls are captured automatically, no manual invocation needed.
- **`experimental.chat.messages.transform` hook** — scans messages for `<!-- EXTRA_RESTORE: <sessionID> -->` marker. When found: reads the header, checks version, reads ToolCall records, reconstructs them as assistant messages via `reconstructMessages()`, splices into the message array. If the marker message is empty after stripping the marker, the message is replaced entirely; otherwise restored messages are inserted after it.
- **Schema versioning**: `writeHeader()` writes `version: 1`. `readHeader()` returns `null` for missing/malformed headers. `restore` action rejects unknown versions with `error: "unknown checkpoint version: N"`. This is forward-compat: future formats bump the version; old code refuses to process them.
- **Test helpers**: `__setCheckpointDir()` overrides the storage directory (avoids writing to `~/.local` during tests), `__cleanup()` flushes all buffers, stops the timer, clears maps.

### judge.ts — multi-criteria LLM scoring with structured prompt

- **Prompt engineering**: `buildJudgePrompt()` constructs a two-message prompt (system + user). System message states the rubric. User message formats candidates as `Candidate #N: \`\`\`...\`\`\`` blocks and provides strict JSON output instructions. The prompt explicitly constrains the output: "Output ONLY a JSON object ... (no other text)."
- **Response parsing**: `parseJudgeResponse()` extracts the first JSON object from the LLM response (handles markdown fences, leading/trailing text via `/\{[\s\S]*\}/` regex). Validates: scores array length matches candidate count, each score is a number in [0,10], winner index is in range, reasoning is a non-empty string. Returns `null` on any validation failure.
- **LLM call**: `callJudge()` uses `ctx.client.session.message()` with `temperature: 0.2` (low temperature for deterministic scoring). Measures latency via `performance.now()`. Returns `{ response: JudgeResponse, latencyMs }`.
- **Fallback heuristic**: when no LLM client is available (`ctx.client.session.message` is missing), judge falls back to length-based scoring: `correctness = min(10, length/100)`, `completeness = min(10, length/150)`, `conciseness = min(10, 800/(length+1))`. Winner is the candidate with the highest sum of three scores. The result includes `model: "heuristic"` and `reasoning: "Fallback heuristic: scored by output length"` so consumers can distinguish LLM-judged from heuristic results.
- **Auto-judge hook**: only registered when `config.judge_auto === true` AND an LLM client is available. `extractCandidatesFromMessages()` scans for `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->` markers (JSON array of candidate strings, min 2). When found, calls the LLM judge and appends a formatted verdict message (`--- F6' Judge Verdict ---`) as an assistant message. Errors in the auto-hook are caught and logged — never block the message pipeline.

### dream.ts — 3-trigger memory cleaner with Promise-lock

- **Database**: opens `~/.local/share/SFFMC/memory/index.sqlite` (the Memory plugin's database) in WAL mode via `new Database(path)`. Assumes the `memory_entries` table exists with columns: `id, source_path, section, content, importance_score, last_accessed, created_at`. Does NOT create the schema — relies on the Memory plugin for that.
- **4-phase cycle** (`runDream`):
  1. **Read**: `SELECT * FROM memory_entries ORDER BY created_at DESC`
  2. **Dedup**: O(n²) pairwise Jaccard similarity. Entries with Jaccard > 0.9 are duplicates; the older one (by `last_accessed` or `created_at`) is marked for deletion. The newer one is kept.
  3. **Stale removal**: entries with `last_accessed < now - 30 days` (or `created_at < now - 30 days` if `last_accessed` is NULL) are archived to `dream-archive.jsonl` and deleted from the DB. Archive format includes `archived_at_ms` and `archived_at_iso` timestamps.
  4. **Summarization**: greedy clustering — each unassigned entry starts a cluster; any other entry with Jaccard > 0.3 to any cluster member is added. Clusters of 5+ entries are replaced with a single summary row (`source_path: "dream-summary"`, `importance_score: max(cluster)`, `content: concatenateSummary(cluster)`). The original entries are deleted.
- **Jaccard similarity**: `tokenize()` lowercases, strips punctuation, splits on whitespace, deduplicates into a Set. `jaccard(a, b) = |A ∩ B| / |A ∪ B|`. Returns 0 when both sets are empty.
- **3 trigger paths**:
  - **Count threshold** (`tool.execute.after` hook): after any tool call, checks `SELECT COUNT(*) FROM memory_entries`. If count exceeds `config.threshold`, fires `executeDream(false)` asynchronously (fire-and-forget, errors caught and logged).
  - **Cron** (`setInterval`): runs every `config.intervalHours * 3600 * 1000` ms. Timer is `unref()`'d so it doesn't block process exit. Timer is cleared and re-created on each `createDreamTool()` call (for test repeatability).
  - **Manual**: LLM calls `extra_dream({ dry_run?: boolean })`. `dry_run` mode simulates the full cycle without writing to DB or archive — useful for preview.
- **Concurrency lock**: module-level `dreamLock: Promise<DreamResult> | null`. Before running, `executeDream()` checks if `dreamLock` is non-null; if so, returns `{ skipped: true, reason: "dream already in progress" }`. After completion (success or failure), `dreamLock` is reset to `null` in a `finally` block. This ensures at most one dream run is active at any time, regardless of trigger source.
- **Summarization gap**: `concatenateSummary()` produces a naive first-100-chars-per-entry concatenation. The intent is to call an LLM for structured summarization, but `ctx` (PluginContext) is not available in the `createDreamTool` factory — only `DreamConfig` fields are passed. LLM summarization is a future enhancement path.

### index.test.ts — shape verification + regression guards

- **Test 1** (`default export shape`): verifies `mod.default` exists, `mod.default.id === "@sffmc/extra"`, `typeof mod.default.server === "function"`.
- **Test 2** (`3 tools, no name field`): verifies all 3 tools are registered under `hooks.tool`, each has a `description` string, `parameters.type === "object"`, `execute` is a function, and `name` is `undefined`. For `extra_checkpoint`, validates the full parameters schema (action enum, sessionID). This is the fix-17 regression guard — ensures no `name` field leaks into tool definitions.
- **Test 3** (`disabled stubs`): with default config (all disabled), calls `execute()` on each tool and verifies `{ ok: true, skipped: true, reason: "feature disabled" }`. Confirms disabled features produce zero side effects.
- **Test 4** (`factory return shapes`): imports each factory function directly, calls with minimal config, verifies each returns `{ tool, hooks }` with both fields defined. Confirms the spread pattern contract is honored by all three factories.
