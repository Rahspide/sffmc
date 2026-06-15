# packages/extra/

## Responsibility

F3+ opt-in bundle for advanced features — F5' Checkpoint (session capture/restore), F6' Judge (multi-criteria LLM scoring), F8 Dream (background memory cleaner). All features disabled by default via independent config flags. Plugin exists as a toggle bundle so users can opt in per feature without enabling the whole plugin. Exposes 3 LLM-callable tools: `extra_checkpoint`, `extra_judge`, `extra_dream`.

## Design Patterns

- **Factory + spread pattern** — each feature is built by a `create<X>Tool(config)` factory that returns `{ tool, hooks }`. `index.ts` spreads all hooks into the top-level return object (so OpenCode registers them) and nests tools under the `"tool"` key. Allows parallel implementation of 3 independent features without cross-contamination in the index.
- **Opt-in via config flags** — 3 independent booleans (`checkpoint`, `judge`, `dream`) plus sub-configs (`dream_threshold`, `judge_model`, `judge_rubric`, etc.). All disabled by default. When disabled, `execute()` logs and returns `{ ok: true, skipped: true, reason: "feature disabled" }` — no side effects.
- **Schema versioning** — `CheckpointState.version = 1` enforced at restore. Unknown versions rejected with error message. Forward-compat pattern: future checkpoint format changes increment version; old restorers reject gracefully.
- **JSONL append-only storage** — checkpoint tool captures `ToolCall` records into per-session JSONL files via `appendFileSync`. In-memory buffer flushes to disk on threshold (50 calls) or interval (5s). Atomic writes guaranteed by single-writer-per-session + `appendFileSync`.
- **Multi-trigger scheduler** — Dream uses 3 trigger paths: (a) count threshold — `tool.execute.after` hook checks `COUNT(*) > threshold`, fire-and-forget; (b) cron — `setInterval` on configurable hours; (c) manual — LLM calls `extra_dream()` directly. Promise-lock (`dreamLock`) prevents concurrent runs.
- **Plugin SDK consumer** — uses `@sffmc/shared`'s `loadConfig<ExtraConfig>` and `PluginContext` type. Config sourced from `~/.config/SFFMC/extra.yaml` with full default fallback.

## Data & Control Flow

```
Plugin loaded by OpenCode
  └─ server(ctx) called
       ├─ loadConfig<ExtraConfig>("extra", defaultConfig)  // YAML merge
        ├─ createCheckpointTool({ enabled:config.checkpoint, dir: resolvedCheckpointDir })
       ├─ createJudgeTool({ enabled:config.judge, model, rubric, judge_auto, ctx })
       ├─ createDreamTool({ enabled:config.dream, threshold, intervalHours, ctx })
       └─ return { ...checkpoint.hooks, ...judge.hooks, ...dream.hooks,
                    tool: { extra_checkpoint, extra_judge, extra_dream } }

── LLM invokes extra_checkpoint({ action, sessionID }) ──
  → CheckpointTool.execute()
    → guard: config.enabled? else → { skipped: true }
    ├─ action="list"    → listSessions() → readdir jsonl files
    ├─ action="delete"  → deleteCheckpoint(sessionID) → unlinkSync
    └─ action="restore" → readHeader() → version check
                        → readToolCalls() → reconstructMessages()

  Also: tool.execute.after hook (auto-capture)
    → build ToolCall record → push to in-memory buffer
    → if buffer.length ≥ 50 → flushSession() → appendFileSync JSONL

  Also: experimental.chat.messages.transform hook (auto-restore)
    → scan for <!-- EXTRA_RESTORE: <sessionID> -->
    → readHeader + version check → readToolCalls → reconstructMessages
    → splice restored messages into the message array

── LLM invokes extra_judge({ candidates: string[], rubric? }) ──
  → JudgeTool.execute()
    → guard: config.enabled? else → { skipped: true }
    → validate candidates.length ∈ [2,8]
    → if ctx.client.session.message available:
        → buildJudgePrompt(candidates, rubric)
        → callJudge() → LLM via session.message()
        → parseJudgeResponse() → extract JSON, validate scores/winner
        → return { scores, winner, reasoning, model, latencyMs }
    → else fallback heuristic: length-based scoring

  Also: experimental.chat.messages.transform hook (auto-judge, opt-in)
    → if config.judge_auto enabled:
        → extractCandidatesFromMessages() scan for marker
        → callJudge() → append verdict as assistant message

── LLM invokes extra_dream({ dry_run?: boolean }) ──
  → DreamTool.execute()
    → guard: config.enabled? else → { skipped: true }
    → guard: dreamLock? → { skipped: true, reason: "already in progress" }
    → acquire dreamLock
    → runDream(db, dryRun):
        1. Read all memory_entries
        2. Dedup: pairwise Jaccard > 0.9 → delete older
        3. Stale removal: last_accessed < now - 30d → archive + delete
        4. Summarization: greedy cluster (Jaccard > 0.3), clusters of 5+ → concat summary row
    → return DreamResult { scanned, deduped, archived, summarized, durationMs }

  Also: tool.execute.after hook (count-threshold auto-trigger)
    → after any tool call, check COUNT(*) > threshold
    → fire-and-forget executeDream()

  Also: cron timer (setInterval)
    → every intervalHours, executeDream()
```

## OpenCode Hooks

| Hook | Feature | Registered When | Behavior |
|---|---|---|---|
| `tool.execute.after` | Checkpoint | `config.checkpoint === true` | Captures every tool call result into in-memory buffer; flushes to JSONL at threshold or interval |
| `experimental.chat.messages.transform` | Checkpoint | `config.checkpoint === true` | Scans messages for `<!-- EXTRA_RESTORE: <id> -->` marker, reconstructs ToolCalls as assistant messages |
| `experimental.chat.messages.transform` | Judge | `config.judge_auto === true` | Scans messages for `<!-- EXTRA_JUDGE_CANDIDATES: [...] -->` marker, calls LLM judge, appends verdict |
| `tool.execute.after` | Dream | `config.dream === true` | After any tool call, checks memory count; triggers dream run if count > threshold |

All hooks are conditional — registered only when their config flag is enabled. Disabled features return `{ skipped: true }` stub responses with zero side effects.

## Integration Points

| Dependency | Used By | Role |
|---|---|---|
| `@sffmc/shared` (workspace:*) | index.ts | `loadConfig<ExtraConfig>("extra", defaults)` — reads `~/.config/SFFMC/extra.yaml`. `PluginContext` type for `projectRoot` |
| `node:fs` | checkpoint.ts, dream.ts | `appendFileSync`, `readFileSync`, `existsSync`, `mkdirSync`, `readdirSync`, `unlinkSync` — JSONL persistence |
| `node:path` | checkpoint.ts, dream.ts | `join`, `dirname`, `resolve` — path construction |
| `node:os` | checkpoint.ts, dream.ts | `homedir()` for default storage paths |
| `bun:sqlite` | dream.ts | `Database` class — queries memory DB (`memory_entries` table) |
| `@sffmc/memory` (implicit) | dream.ts | Dream reads/writes the `memory_entries` table created by the Memory plugin. Dream assumes the `(id, source_path, section, content, importance_score, last_accessed, created_at)` schema |
| LLM client (via `ctx.client.session.message`) | judge.ts | Judge sends candidates to an LLM for structured scoring. Falls back to length-based heuristic if no client available |
| **Consumer** | — | OpenCode plugin loader via `file://` path in `plugin[]` array |

## Public API

### Export: index.ts

| Export | Kind | Signature |
|---|---|---|
| `ExtraConfig` | interface | `{ checkpoint: boolean; judge: boolean; dream: boolean; dream_threshold: number; dream_interval_hours: number; judge_model: string; judge_rubric: string; judge_auto: boolean; checkpoint_dir: string }` |
| `default` | plugin module | `{ id: "@sffmc/extra", server: (ctx: PluginContext) => Promise<{ tool: {...}, ...hooks }> }` |

### Export: checkpoint.ts

| Export | Kind | Signature |
|---|---|---|
| `createCheckpointTool` | factory function | `(config: { enabled: boolean; dir?: string }) => { tool: CheckpointTool; hooks: CheckpointHooks }` |
| `CheckpointTool` | interface | Tool shape with `description`, `parameters` (JSON Schema), `execute(args?)` |
| `CheckpointHooks` | interface | Optional `tool.execute.after` and `experimental.chat.messages.transform` hook signatures |
| `ToolCall` | interface | `{ tool: string; args: unknown; result: unknown; timestamp: number; callID: string }` |
| `CheckpointState` | interface | `{ sessionID: string; toolCalls: ToolCall[]; createdAt: number; updatedAt: number; version: 1 }` |
| `filePath` | function | `(sessionID: string) => string` — resolve JSONL path for a session |
| `readToolCalls` | function | `(sessionID: string) => ToolCall[]` — parse and return all calls from JSONL |
| `listSessions` | function | `() => string[]` — list all checkpointed session IDs |
| `flushSession` | function | `(sessionID: string) => void` — force-write buffer to JSONL |
| `flushAll` | function | `() => void` — flush all session buffers |
| `__setCheckpointDir` | function | `(dir: string) => void` — override storage dir (for tests) |
| `__cleanup` | function | `() => void` — flush buffers, stop timer, clear maps (for tests) |

### Export: judge.ts

| Export | Kind | Signature |
|---|---|---|
| `createJudgeTool` | factory function | `(config: JudgeConfig) => { tool: JudgeTool; hooks: JudgeHooks }` |
| `JudgeConfig` | interface | `{ enabled: boolean; model: string; rubric: string; judge_auto?: boolean; ctx?: RichPluginContext }` |
| `JudgeTool` | interface | Tool shape with `description`, `parameters` (candidates array 2-8, rubric), `execute(input?)` |
| `JudgeHooks` | interface | Optional `experimental.chat.messages.transform` hook signature |
| `JudgeInput` | interface | `{ candidates: string[]; rubric?: string }` |
| `JudgeResult` | interface | `{ ok: true; scores: JudgeScore[]; winner: number; reasoning: string; model: string; latencyMs: number }` |
| `JudgeError` | interface | `{ ok: false; error: string }` |
| `JudgeSkipped` | interface | `{ ok: true; skipped: true; reason: string }` |
| `JudgeExecuteResult` | type | `JudgeResult \| JudgeError \| JudgeSkipped` |
| `JudgeScore` | interface | `{ correctness: number; completeness: number; conciseness: number }` |
| `buildJudgePrompt` | function | `(candidates: string[], rubric: string) => { system: string; user: string }` |
| `parseJudgeResponse` | function | `(raw: string, n: number) => JudgeResponse \| null` |
| `extractCandidatesFromMessages` | function | `(messages: Array<{role,content}>) => string[] \| null` |

### Export: dream.ts

| Export | Kind | Signature |
|---|---|---|
| `createDreamTool` | factory function | `(config: DreamConfig) => { tool: DreamTool; hooks: DreamHooks }` |
| `DreamConfig` | interface | `{ enabled: boolean; threshold: number; intervalHours: number; storagePath?: string; ctx?: RichPluginContext; summaryModel?: string }` |
| `DreamTool` | interface | Tool shape with `description`, `parameters` (dry_run boolean), `execute(params?)` |
| `DreamHooks` | interface | Optional `tool.execute.after` hook signature |
| `DreamResult` | interface | `{ scanned: number; deduped: number; archived: number; summarized: number; durationMs: number; errors: string[]; ok: boolean; skipped?: boolean; reason?: string; dry_run?: boolean }` |
| `clearCronTimer` | function | `() => void` — stop the cron interval (for tests) |
| `isDreamLocked` | function | `() => boolean` — inspect concurrency lock (for tests) |

## Notable

- **All features default off** — YAGNI principle applied at the tool level. Each of the 3 features requires an explicit boolean flip in `extra.yaml`. When disabled, tools return a predictable `{ skipped: true }` shape with zero side effects and no hook registration.
- **Dream summarizes via LLM with concat fallback** — `createDreamTool` now accepts `ctx` and `summaryModel` for LLM-based summarization via `summarizeViaLLM()` (sends cluster entries to the model for a 1-3 sentence summary). Falls back to `concatenateSummary()` (first-100-chars-per-entry concatenation) when `ctx` is absent or the LLM call fails. The fallback ensures Dream works even without an available LLM client.
- **`ExtraConfig.checkpoint_dir` now wired** — `index.ts` resolves `config.checkpoint_dir || DEFAULT_CHECKPOINT_DIR` and passes the result as `dir` to `createCheckpointTool`. All internal functions (`filePath`, `writeHeader`, `readHeader`, `flushSession`, `listSessions`, etc.) accept an optional `dir?` parameter that defaults to the old hardcoded path. `__setCheckpointDir()` remains for test isolation.
- **Judge auto-hook is opt-in within opt-in** — even when `config.judge === true`, the auto-judge marker scanner only activates when `config.judge_auto === true` AND an LLM client is available. This double-gate prevents the plugin from silently injecting LLM calls into every message transform.
- **Bundle exists so user can opt in per feature** — the 3 tools could be 3 separate plugins (matching the DLC "hot-pluggable" principle), but they share the same config file (`extra.yaml`) and the same `@sffmc/shared` dependency. Bundling reduces install surface while keeping feature isolation via config flags.
