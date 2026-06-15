# packages/max-mode/

## Responsibility

F7 Max Mode plugin for hard problems — generates N parallel candidate drafts at high temperature, asks a judge model to pick the best one, and presents the winner with captured (but unexecuted) tool calls for user review. Activated via the `/max` slash command.

## Design Patterns

- **Schema-only tool trick** — during candidate generation, tool `execute` functions are stripped (`stripToolExecutes`). The model still sees tool definitions so it can suggest calls, but the calls are captured in `Candidate.toolCalls` rather than executed. After judgment, the user reviews them and confirms via `/max execute`. The state is restored (`restoreToolExecutes`) to re-attach `execute` functions when Max Mode is done.
- **Restore state machine** — `RestoreState` tracks `stripped: boolean` and a `Map<string, SchemaOnlyTool>` backup. `stripToolExecutes` is idempotent (won't double-strip), `restoreToolExecutes` is a no-op when not stripped, and `isSchemaOnly` provides a live read. This avoids accidental re-stripping across hook invocations.
- **Dry-run mode** — two layers: `MaxModeConfig.dry_run` (persistent config flag, logged at startup) and `--dry-run` on the `/max` command (per-invocation). When either is active, the command prints estimated costs (N × single call) and the budget cap without calling any model.
- **Fallback judge** — `judgeCandidates` has a three-tier fallback chain: SDK available → parse LLM JSON verdict → `fallbackVerdict` (picks longest draft, confidence 0.3). The fallback fires on missing SDK, network error, or unparseable output — Max Mode never fails silently.
- **One-shot verdict injection** — the winner message is stored on `ctx._maxModeResult` after judgment and consumed exactly once by `experimental.chat.system.transform` or `experimental.chat.messages.transform` (whichever fires first). The delete-after-use pattern prevents stale verdicts from persisting across turns.

## Data & Control Flow

```
User types "/max <problem>"
  │
  ▼
command.execute.before
  │
  ├── dry-run? → log estimate, return
  │
  ├── maxUsedThisSession? → skip (prevent re-entry)
  │
  ▼
generateCandidates(prompt, config, ctx)
  │  ├── Promise.allSettled of N session.message() calls
  │  ├── each with buildCandidatePrompt (Candidate #X of N)
  │  └── returns Candidate[] (draft, toolCalls, tokens)
  │
  ▼
judgeCandidates(candidates, judgeModel, ctx)
  │  ├── buildJudgePrompt (all drafts truncated to 8000 chars each)
  │  ├── session.message() → parseVerdict (JSON regex extraction)
  │  └── returns Verdict { winner, reasoning, confidence }
  │
  ▼
buildWinnerMessage(winnerCandidate, verdict)
  │  └── formats: verdict header, reasoning, winner draft, suggested tool calls
  │
  ▼
Store on ctx._maxModeResult
  │
  ▼
Next system/messages transform hook fires → injects verdict → deletes _maxModeResult
  │
  ▼
User sees winner + "SUGGESTED TOOL CALLS (NOT EXECUTED)"
  │
  ▼
User reviews → types "/max execute"
  │
  ▼
restoreToolExecutes() → state reset → normal tool execution resumes
```

## OpenCode Hooks

| # | Hook | Purpose |
|---|------|---------|
| 1 | `config` | No-op — config already loaded in `server()` factory |
| 2 | `command.execute.before` | Intercepts `/max` (generate + judge flow), `/max execute` (restore tools), `/max --dry-run` (estimate only). Guards against re-entry via `maxUsedThisSession`. |
| 3 | `experimental.chat.system.transform` | Pushes winner message onto `data.system[]` array, then self-deletes `ctx._maxModeResult`. |
| 4 | `tool.execute.before` | In schema-only mode (`isSchemaOnly(state)`), tags args with `_schemaOnly: true` to prevent actual tool execution. |
| 5 | `experimental.chat.messages.transform` | Same as hook 3 but pushes winner as an assistant message onto `data.messages[]`. Deletes `_maxModeResult` after use. |

Hooks 3 and 5 are mutually exclusive consumers — whichever fires first wins. The `delete` pattern ensures the verdict is injected exactly once per Max Mode run.

## Integration Points

- **`yaml` (v2)** — sole runtime dependency. Used to parse `~/.config/SFFMC/max-mode.yaml` via `loadConfig()`. Merged with `defaultConfig` via spread.
- **Custom `loadConfig`** — the plugin does NOT use `@sffmc/shared` (which has complex `sessionID`/`client` types). Instead it has its own `loadConfig()` using `fs.readFileSync` + `yaml.parse` + `os.homedir()`. This keeps the plugin self-contained and avoids the shared package's type coupling.
- **SDK `client.session.message()`** — the plugin's sole AI interface. Both `generateCandidates` and `judgeCandidates` depend on this being present on `ctx.client.session`. When absent, the judge falls back to heuristic; candidate generation throws.
- **No HTTP, no MCP, no DB** — the plugin is pure in-process. No network calls beyond the SDK's own session transport.

## Public API

| Export | Kind | Description |
|--------|------|-------------|
| `generateCandidates` | `async (prompt, config, ctx) → Candidate[]` | Runs N parallel model calls via `Promise.allSettled` |
| `judgeCandidates` | `async (candidates, judgeModel, ctx) → Verdict` | Judge model picks winner; falls back to longest-draft heuristic |
| `Candidate` | Interface | `{ id, temperature, draft, toolCalls, tokens }` |
| `Verdict` | Interface | `{ winner, reasoning, confidence }` |
| `MaxModeConfig` | Interface (local) | `{ n_candidates, candidate_models, candidate_temperature, judge_model, budget_cap_multiplier, dry_run }` |
| `makeSchemaOnlyTools` | `(tools) → SchemaOnlyTool[]` | Strips `execute` from tools for schema-only mode |
| `buildCandidatePrompt` | `(prompt, index, total) → Message[]` | Builds "Candidate #X of N" system + user message pair |
| `buildJudgePrompt` | `(candidates) → string` | Formats all drafts for judge evaluation |
| `parseVerdict` | `(raw, n) → Verdict \| null` | JSON extraction with bounds validation |
| `createRestoreState` | `() → RestoreState` | Creates empty state for strip/restore cycle |
| `stripToolExecutes` | `(tools, state) → SchemaOnlyTool[]` | Removes execute, saves backup |
| `restoreToolExecutes` | `(tools, state) → void` | Restores execute from backup |
| `isSchemaOnly` | `(state) → boolean` | Live check of stripped state |
| `default` | Plugin | `{ id: "@sffmc/max-mode", server }` — the OpenCode plugin entry |
