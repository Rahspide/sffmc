# packages/compose/src/

## Responsibility

Plugin entry point for `@sffmc/compose`. Registers the `compose_skill` OpenCode tool that reads workflow skill documents from the `skills/` directory. Thin integration layer — 57 lines of glue between the file system and the OpenCode tool registry.

## Design Patterns

- **Static file registry** — `VALID_SKILLS` is a `const` array typed with `as const`, generating the `SkillName` union type. No dynamic imports, no runtime discovery.
- **Wrapper plugin pattern** — Exports `{ id: "@sffmc/compose", server }`. The `server` function is `async`, returns `{ tool: { compose_skill: { description, parameters, execute } } }`. Follows the OpenCode plugin contract where `server(ctx)` returns hook registrations.
- **Validation gate** — `VALID_SKILLS.includes(name)` guards the `readFile` call. Unknown skill names return an error string with the valid skills list.
- **No config consumption** — `PluginContext` is imported for type contract compliance but the `_ctx` parameter is prefixed with underscore (intentionally unused). The plugin needs no project context.
- **Bun test suite** — 6 tests in `index.test.ts`: file integrity loop (15 iterations), export shape, server hook shape, execute for "verify", execute for "plan", unknown skill error.

## Data & Control Flow

```
Module load:
  1. import.meta.dirname resolved at load time
  2. SKILLS_DIR = join(dirname, "..", "skills")
  3. VALID_SKILLS = ["ask", "brainstorm", ..., "worktree"] as const
  4. SkillName = union type from VALID_SKILLS

Tool call:
  compose_skill.execute({ name: string })
    → VALID_SKILLS.includes(name)?
      yes → readFile(join(SKILLS_DIR, `${name}.md`), "utf-8") → return content
      no  → return error string with valid names list

Error path: No file-not-found handling beyond the validation gate.
If the .md file exists but is empty or unreadable, the error propagates as a thrown exception.
```

## OpenCode Hooks

| Hook | Registration | Purpose |
|------|-------------|---------|
| `tool` | `compose_skill` | Returns full markdown content of a named skill file |

One parameter accepted: `name` (string). The `execute` function is `async` and returns `string`.

## Integration Points

| Import | Usage |
|--------|-------|
| `readFile` from `node:fs/promises` | Loads `skills/<name>.md` as UTF-8 string |
| `join` from `node:path` | Resolves `SKILLS_DIR` relative to `import.meta.dirname` |
| `PluginContext` from `@sffmc/shared` | Type-only — `server(ctx)` contract, `ctx` unused |
| `skills/*.md` (15 files) | Raw markdown content returned by `execute` |

## Public API

```typescript
// Module export (consumed by OpenCode plugin loader)
export default {
  id: "@sffmc/compose",
  server: async (ctx: PluginContext) => ({
    tool: {
      compose_skill: {
        description: string,
        parameters: {
          name: {
            type: "string",
            description: `Skill name: ask, brainstorm, debug, execute, feedback, merge, new-skill, parallel, plan, report, review, subagent, tdd, verify, worktree`
          }
        },
        execute: async ({ name }: { name: SkillName }) => string
      }
    }
  })
}
```

## Files

| Path | Purpose |
|------|---------|
| `src/index.ts` | Plugin entry — registers `compose_skill` tool, validates skill names, reads `.md` from `skills/` |
| `src/index.test.ts` | 6 Bun tests — skill file integrity (15 files exist, >100 bytes, attribution), plugin export shape, tool hook shape, execute returns content for "verify"/"plan", unknown skill error |
| `skills/ask.md` | Structured user questioning workflow with self-resolution fallback |
| `skills/brainstorm.md` | Mandatory pre-creative-work requirement exploration |
| `skills/debug.md` | Systematic bug/test failure diagnosis protocol |
| `skills/execute.md` | Plan execution in separate session with review gates |
| `skills/feedback.md` | Code review feedback processing with technical rigor |
| `skills/merge.md` | Post-implementation integration decision workflow |
| `skills/new-skill.md` | Skill lifecycle — create, edit, verify before deployment |
| `skills/parallel.md` | Independent task parallelization dispatch |
| `skills/plan.md` | Spec-to-plan transformation before touching code |
| `skills/report.md` | Final-state report from multiple spec iterations |
| `skills/review.md` | Code review dispatch with reviewer context crafting |
| `skills/subagent.md` | Per-task subagent dispatch with two-phase spec review gate |
| `skills/tdd.md` | TDD cycle — RED → GREEN → REFACTOR with iron law enforcement |
| `skills/verify.md` | Evidence-gated completion verification — no claims without fresh output |
| `skills/worktree.md` | Isolated workspace setup via git worktrees |
