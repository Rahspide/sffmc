# packages/max-mode/src/

## Responsibility

Core implementation of F7 Max Mode — parallel candidate generation, judge selection, tool-call capture/restore, and OpenCode hook wiring. All five source files compile to a single plugin entry at `src/index.ts`.

## Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry point — `loadConfig()`, hook wiring (5 hooks), winner message builder, `export default { id, server }` |
| `src/candidates.ts` | Candidate generation — `generateCandidates()` (Promise.allSettled), `buildCandidatePrompt()`, `makeSchemaOnlyTools()`, `Candidate` and `ToolCall` types |
| `src/judge.ts` | Judge pipeline — `judgeCandidates()` (LLM + fallback), `buildJudgePrompt()`, `parseVerdict()` (JSON regex extraction + validation), `fallbackVerdict()` (longest-draft heuristic) |
| `src/restore.ts` | Tool-call state machine — `stripToolExecutes()`, `restoreToolExecutes()`, `createRestoreState()`, `isSchemaOnly()`. The schema-only tool trick implementation. |
| `src/index.test.ts` | Test suite — 31 tests covering candidates (7), judge (12), restore (5), plugin entry (6) |

## Design Patterns

- **Schema-only tool trick** — `stripToolExecutes()` removes `execute` from each tool and saves the originals in a `Map<string, SchemaOnlyTool>` on `RestoreState`. The model still sees `definition` (name, description, parameters) so it can suggest tool calls, but those calls are captured in `Candidate.toolCalls` and tagged with `_schemaOnly: true` by the `tool.execute.before` hook. `restoreToolExecutes()` re-attaches `execute` when the user types `/max execute`.
- **Promise.allSettled for parallel candidates** — `generateCandidates()` fires N concurrent `session.message()` calls via `Promise.allSettled`. Failed promises become error-marked candidates (`[ERROR] Candidate N failed`) rather than aborting the whole run. This tolerates partial model failures.
- **Three-tier judge fallback** — `judgeCandidates()` tries: (1) SDK call to judge model at temperature 0.1, (2) JSON parse via `parseVerdict()` with regex extraction and bounds validation, (3) `fallbackVerdict()` picking the longest draft at confidence 0.3. The fallback is defense-in-depth — Max Mode completes even if the judge model is unavailable or returns unparseable output.
- **One-shot side-channel injection** — `ctx._maxModeResult` stores the verdict after `/max` completes. Both `experimental.chat.system.transform` and `experimental.chat.messages.transform` check for it and `delete` it after use. This is a workaround for the SDK not exposing direct message injection from the command hook.
- **Re-entry guard** — `maxUsedThisSession` flag prevents a second `/max` invocation in the same session after one has already run. Reset by `/max execute`.

## Data & Control Flow

```
src/index.ts (server factory)
  │
  ├── loadConfig() → ~/.config/SFFMC/max-mode.yaml || defaultConfig
  ├── createRestoreState() → RestoreState { tools: Map, stripped: false }
  │
  ├── command.execute.before ("/max ...")
  │   ├── "/max execute" → restore.ts → restoreToolExecutes()
  │   ├── "/max --dry-run" → log estimate
  │   └── "/max <prompt>"
  │       ├── candidates.ts → generateCandidates()
  │       │   ├── buildCandidatePrompt() × N
  │       │   ├── Promise.allSettled( session.message() × N )
  │       │   ├── extract text + toolCalls from response content[]
  │       │   └── return Candidate[]
  │       │
  │       ├── estimateCost(candidates) → token sum
  │       │
  │       ├── judge.ts → judgeCandidates()
  │       │   ├── buildJudgePrompt() — drafts truncated to 8000 chars each
  │       │   ├── session.message(judgeModel, temp=0.1)
  │       │   ├── parseVerdict() — regex JSON extraction + validation
  │       │   └── fallbackVerdict() on any failure
  │       │
  │       ├── buildWinnerMessage(candidate[winner], verdict)
  │       │   └── format: header + reasoning + draft + tool calls + /max execute hint
  │       │
  │       └── store on ctx._maxModeResult
  │
  ├── experimental.chat.system.transform
  │   └── if ctx._maxModeResult → push to data.system[] → delete result
  │
  ├── tool.execute.before
  │   └── if isSchemaOnly(state) → args._schemaOnly = true
  │
  └── experimental.chat.messages.transform
      └── if ctx._maxModeResult → push assistant message → delete result
```

## OpenCode Hooks

All 5 hooks are registered in `server()` and returned as the plugin shape. Execution order in the OpenCode lifecycle:

1. **`config`** — fires on plugin load, no-op (config loaded eagerly in `server()`)
2. **`command.execute.before`** — fires when user submits any `/` command; only `/max*` commands are handled
3. **`experimental.chat.system.transform`** — fires on next chat turn, injects verdict into system prompt
4. **`tool.execute.before`** — fires before every tool call during Max Mode; tags schema-only calls
5. **`experimental.chat.messages.transform`** — alternative injection path, fires on message assembly

## Integration Points

- **`yaml` (v2)** — imported directly in `src/index.ts`. Used in `loadConfig()` to parse YAML config file. No YAML processing elsewhere in the src tree.
- **`fs.readFileSync` + `os.homedir`** — used by `loadConfig()` to locate and read `~/.config/SFFMC/max-mode.yaml`. No `@sffmc/shared` dependency — the plugin is self-contained.
- **SDK `client.session.message()`** — accessed via `ctx.client?.session?.message`. Each source file defines its own local `PluginContext` interface (no shared type). This is the only interface to the AI backend.
- **No `@sffmc/shared`** — the plugin deliberately avoids the shared package's complex type dependencies (`sessionID`/`client` generics). Each file has a minimal local `PluginContext` interface with only the fields it needs.

## Public API

All exports are re-exported through `src/index.ts`:

| Export | Source file | Description |
|--------|-------------|-------------|
| `generateCandidates` | `candidates.ts` | Fire N parallel model calls, return Candidate[] |
| `judgeCandidates` | `judge.ts` | Judge model selects winner, fallback to heuristic |
| `makeSchemaOnlyTools` | `candidates.ts` | Strip execute from tool definitions |
| `buildCandidatePrompt` | `candidates.ts` | Build "Candidate #X of N" message pair |
| `buildJudgePrompt` | `judge.ts` | Format all drafts for judge evaluation |
| `parseVerdict` | `judge.ts` | Extract and validate JSON verdict from LLM output |
| `createRestoreState` | `restore.ts` | Initialize RestoreState |
| `stripToolExecutes` | `restore.ts` | Remove execute, save original references |
| `restoreToolExecutes` | `restore.ts` | Re-attach execute from saved references |
| `isSchemaOnly` | `restore.ts` | Read current stripped state |
| `Candidate` (type) | `candidates.ts` | `{ id, temperature, draft, toolCalls, tokens }` |
| `ToolCall` (type) | `candidates.ts` | `{ name, args, id }` |
| `Verdict` (type) | `judge.ts` | `{ winner, reasoning, confidence }` |
| `default` | `index.ts` | OpenCode plugin `{ id, server }` |
