# @sffmc/cognition

> **Part of `@sffmc/agentic` composite.** This package is a sub-feature of the agentic bundle. Load via `@sffmc/agentic` for the full set (compose + max-mode + workflow + health), or standalone if you only need the 18 compose skills.

18 compose skills — ported from MiMo-Code.

## What it does

Loads Compose Mode skills on demand via the `compose_skill` tool. Each skill is a markdown document under `skills/` that the agent can pull into its context with a single tool call. The 18 skills are: `ask`, `audit-deps`, `benchmark`, `brainstorm`, `code-review`, `debug`, `execute`, `feedback`, `merge`, `new-skill`, `parallel`, `plan`, `report`, `review`, `subagent`, `tdd`, `verify`, `worktree`. Originally part of MiMo-Code's Compose Mode; ported over as structured workflows for SFFMC agents.

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

Optional. The default skill set is loaded from `packages/compose/skills/`. To use a custom directory, set `compose.skillsDir` in `~/.config/sffmc/compose.yaml` — the plugin will then read all `*.md` files from that directory at startup and accept any markdown filename (not just the default 18 names) as a valid `compose_skill` argument. To add a new skill to the default set, drop a `<name>.md` file under `packages/compose/skills/` and append the name to `DEFAULT_SKILLS` in `src/index.ts`.

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

(Tests live in the root `bun test` suite — see root README.)

## License

MIT
