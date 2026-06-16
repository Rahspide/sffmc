# @sffmc/compose

> **Part of `@sffmc/agentic` MSP.** This package is a sub-feature of the agentic bundle. Load via `@sffmc/agentic` for the full set (compose + max-mode + workflow + health), or standalone if you only need the 18 compose skills.

15 compose skills (W4) — ported from MiMo-Code.

## What it does

Loads Compose Mode skills on demand via the `compose_skill` tool. Each skill is a markdown document under `skills/` that the agent can pull into its context with a single tool call. The 15 skills are: `ask`, `brainstorm`, `debug`, `execute`, `feedback`, `merge`, `new-skill`, `parallel`, `plan`, `report`, `review`, `subagent`, `tdd`, `verify`, `worktree`. Originally part of MiMo-Code's Compose Mode; ported over as structured workflows for SFFMC agents.

## Install

This plugin is loaded by the SFFMC monorepo's sandbox config. To use standalone:

```ts
// ~/.config/opencode/opencode.json
{
  "plugin": [
    "file:///path/to/SFFMC/packages/compose/src/index.ts"
  ]
}
```

## Configuration

None — `compose` takes no config. Skills are loaded directly from `packages/compose/skills/`. To add a new skill, drop a `<name>.md` file there and add the name to the `VALID_SKILLS` array in `src/index.ts`.

## Hooks registered

| Hook | Purpose |
|---|---|
| `tool` | Register the `compose_skill` tool: read a skill's markdown by name and return its content |

The tool's parameters:

```ts
compose_skill({
  name: "verify" | "tdd" | "plan" | "review" | "subagent" | /* ... 10 more */
})
```

## Tests

```bash
bun test packages/compose/
```

6 tests in `src/index.test.ts`.

## License

MIT
