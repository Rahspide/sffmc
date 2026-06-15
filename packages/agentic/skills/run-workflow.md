---
name: agentic:run-workflow
description: "Use when the task needs a multi-step, sandboxed execution: deep research, security audit, TDD cycles, refactor, doc gen, lib migration, or plan mode. The workflow tool runs JavaScript in a QuickJS WASM sandbox with 7 builtins and custom workflows from the project root."
hidden: true
---

# Running Workflows

## The Rule

When the task is "do X across N steps with rules", use the workflow tool. When it's "do X once", just do X. Workflows shine for repeatable, branchable, multi-step logic — they isolate execution from context and keep the main turn clean.

## The 7 Builtins (Out of the Box)

| Builtin | What it does |
|---|---|
| `deep-research` | Multi-source web research with synthesis |
| `security-audit` | Find secrets, vulns, dependency issues |
| `tdd` | Red-green-refactor cycles for a function |
| `refactor` | Apply a refactor pattern across N files |
| `plan` | Generate a step-by-step plan for a goal |
| `doc-gen` | Generate docs from code |
| `lib-migrate` | Port a lib from version A to B |

## Tool Call (Using a Builtin)

```
workflow({
  builtin: "security-audit",
  args: { path: "./packages/memory", severity: "high" },
})
// Returns: { findings: [...], summary, duration_ms }
```

## Custom Workflows

Place `.js` files at `<projectRoot>/.sffmc/workflows/<name>.js`. The tool discovers them and runs in the same sandbox. The QuickJS sandbox has no `fs`, no `process` — only the workflow API. Your script receives `(api, args)` and returns a result object.

## Sandbox Limits

- **No filesystem access** — use the API to read files explicitly
- **No network** — use the API's `fetch` hook
- **No `eval`** — QuickJS enforces
- **5s default timeout per step** — configurable
- **Max 10MB heap** — configurable

## When to Use Builtins vs Custom

- **Builtin matches your need** → use builtin (tested, versioned, requires zero setup)
- **Custom logic specific to your project** → write a `.js` workflow
- **Builtin is *almost* right but needs a tweak** → copy the builtin template, customize, place in `.sffmc/workflows/`

## Examples

- "Find all secrets in this repo" → `workflow({ builtin: "security-audit" })`
- "Generate API docs for ./src/api" → `workflow({ builtin: "doc-gen", args: { input: "./src/api" } })`
- "Migrate from express v4 to fastify" → `workflow({ builtin: "lib-migrate", args: { from: "express@4", to: "fastify" } })`
- "Write a TDD cycle for the `parseUser` function" → `workflow({ builtin: "tdd", args: { target: "./src/parseUser.ts" } })`

## Why This Skill Exists

Without it, the LLM does multi-step work inline, ballooning context with intermediate state, scrolling away from relevant code, and losing track of the plan. Workflows isolate execution in a resumable, sandboxed runtime — each step starts with a clean stack, and the result comes back as a single structured block.
