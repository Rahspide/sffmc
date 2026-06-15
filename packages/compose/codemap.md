# packages/compose/

## Responsibility

Loads Compose Mode skills on demand for LLM agents. A static 15-skill catalog ported from MiMo-Code — each skill is a self-contained markdown workflow document that agents pull into context via a single `compose_skill` tool call. No runtime skill discovery; the catalog is baked into `VALID_SKILLS`.

## Design Patterns

- **Static file registry** — `VALID_SKILLS` is a `const` array of 15 literal string names. No dynamic directory scanning, no plugin manifest, no runtime discovery. Adding a skill requires editing `src/index.ts` and dropping a `<name>.md` file.
- **15-skill catalog** — Every skill is a standalone `.md` file in `skills/`. Each file has YAML frontmatter (`name`, `hidden`, `description`) followed by the workflow body. All files are verbatim copies from `XiaomiMiMo/MiMo-Code` at commit `42e7da3`.
- **LLM-callable compose_skill tool** — The plugin registers a single OpenCode tool hook (`compose_skill`). One parameter (`name`), one execution path (`readFile` → return string). The returned markdown is injected by the LLM as a prompt fragment.
- **Wrapper plugin pattern** — Exports `{ id, server }` where `server` is an `async` function returning `{ tool: { compose_skill: { ... } } }`. The `_ctx` parameter is accepted but unused (no config needed).
- **No configuration** — The plugin takes zero config. Skill directory path is resolved relative to `import.meta.dirname` at module load time.

## Data & Control Flow

```
LLM calls compose_skill({ name: "tdd" })
         │
         ▼
  server(ctx) → tool.compose_skill.execute({ name })
         │
         ▼
  VALID_SKILLS.includes(name) check
         │
    ┌────┴────┐
    ▼         ▼
  valid     invalid → return "Error: Unknown skill..."
    │
    ▼
  readFile(join(SKILLS_DIR, `${name}.md`), "utf-8")
         │
         ▼
  return markdown string → LLM injects as prompt fragment
```

`SKILLS_DIR` is computed once at module load: `join(import.meta.dirname, "..", "skills")`. The `ctx` object (`PluginContext`) is destructured but unused — the tool is stateless and path-driven.

## OpenCode Hooks

| Hook | What it registers |
|------|-------------------|
| `tool` | `compose_skill` — reads a skill `.md` by name and returns its full markdown content |

No `config`, `event`, or other hooks — this plugin only exposes one tool.

## Integration Points

| Connection | Details |
|------------|---------|
| `@sffmc/shared` | Imports `PluginContext` type (has `projectRoot`, `config`, index signature). Used for `server(ctx)` contract but `ctx` is not consumed. |
| `node:fs/promises` | `readFile` for reading skill `.md` files from disk. |
| `node:path` | `join` for resolving `SKILLS_DIR` relative to `import.meta.dirname`. |
| 15 static `.md` files | Located in `skills/` directory. Each file must exist (enforced by tests). |
| OpenCode plugin loader | Loaded via `file://` URL in `opencode.json` plugin array. Exported shape: `{ id: "@sffmc/compose", server }`. |

## Public API

```typescript
// Single tool exposed to LLM
compose_skill({
  name: "verify" | "tdd" | "plan" | "review" | "subagent"
       | "ask" | "brainstorm" | "debug" | "execute" | "feedback"
       | "merge" | "new-skill" | "parallel" | "report" | "worktree"
})
// → returns string (full markdown content of skills/<name>.md)
// → returns "Error: Unknown skill \"...\". Valid skills: ..." if name invalid
```

## Skill Catalog

| # | Skill | Description |
|---|-------|-------------|
| 1 | `ask` | Structured user questioning — decisions, clarifications, approvals; self-resolve when user unavailable |
| 2 | `brainstorm` | Mandatory pre-creative-work exploration of user intent, requirements, and design |
| 3 | `debug` | Bug and test failure diagnosis — systematic investigation before proposing fixes |
| 4 | `execute` | Written plan execution in a separate session with review checkpoints and progress tracking |
| 5 | `feedback` | Code review feedback processing with technical rigor — no performative agreement |
| 6 | `merge` | Integration decisions after implementation complete — merge, PR, or cleanup options |
| 7 | `new-skill` | Creating, editing, and verifying compose skills before deployment |
| 8 | `parallel` | Independent-task dispatch when tasks share no state and have no sequential dependencies |
| 9 | `plan` | Multi-step task planning from spec/requirements before touching code |
| 10 | `report` | Final-state report consolidating spec iterations, marking related specs, recording lessons |
| 11 | `review` | Code review dispatch for tasks, major features, or pre-merge verification |
| 12 | `subagent` | Per-task subagent dispatch in current session with spec-anchored two-phase review gate |
| 13 | `tdd` | Test-Driven Development — RED (write failing test) → GREEN (minimal code) → REFACTOR |
| 14 | `verify` | Evidence-before-claims verification gate — no completion claims without fresh command output |
| 15 | `worktree` | Isolated workspace setup via git worktrees (with native tool detection and fallback) |
