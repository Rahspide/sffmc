# @sffmc/cognition

**Parallel reasoning + structured-workflow skills + plugin health diagnostics for OpenCode.** Three formerly-separate sub-features (`@sffmc/max-mode`, `@sffmc/compose`, `@sffmc/health`) live here as internal sub-folders; the package entry composes them into one plugin via `mergeHooks()`.

## What's inside

- **`max-mode/`** — `maxMode()` tool. Run a workflow under several candidate generators in parallel; an LLM judge scores each output on configurable criteria and returns the winner. Useful when one generator is flaky and you want a second opinion rather than a retry loop.
- **`compose/skills/`** — 18 markdown skill files that load into OpenCode's prompt: `plan.md`, `tdd.md`, `verify.md`, `review.md`, `debug.md`, `brainstorm.md`, etc. The LLM knows when to load them based on the user's request.
- **`health/`** — `sffmc_health` tool. Returns a JSON diagnostic of plugin load order, hook collisions, missing-config warnings, and per-package health. Useful for `sffmc doctor`-style reports in a chat session.

## Architecture

- `packages/cognition/src/index.ts` — composes the three sub-features with `mergeHooks()`
- `packages/cognition/src/max-mode/src/index.ts` — `maxMode()` implementation
- `packages/cognition/src/compose/src/index.ts` — skill registry
- `packages/cognition/src/health/src/index.ts` — health tool implementation

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    "npm:@sffmc/cognition@^0.15.1"
  ]
}
```

## Skills

See `packages/cognition/src/compose/skills/` for the full list. Each `.md` file is a self-contained prompt fragment the LLM loads on demand:

- `ask.md` — clarify ambiguous user input before acting
- `benchmark.md` — measure baseline cost / latency / accuracy before optimizing
- `brainstorm.md` — generate multiple candidate plans before picking one
- `code-review.md` — second-pass review against the spec
- `debug.md` — diagnose a failing test or build
- `execute.md` — drive a known-good plan to completion, reporting only deviations
- `feedback.md` — turn user feedback into concrete action items
- `merge.md` — orchestrate merges when multiple agents touched the same files
- `new-skill.md` — meta: write a new skill file
- `parallel.md` — split a large task across parallel agents
- `plan.md` — produce a numbered implementation plan from a vague goal
- `report.md` — summarize progress and remaining work
- `review.md` — adversarial review of an agent's work
- `subagent.md` — launch a sub-agent with a clear scope and return format
- `tdd.md` — write a failing test first, then the implementation
- `verify.md` — confirm an implementation satisfies the original requirement
- `worktree.md` — manage isolated git worktrees for parallel work

## License

[MIT](../../LICENSE)
</content>