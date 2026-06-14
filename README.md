# SFFMC — Some Features From MiMo Code

OpenCode plugin suite porting killer features from Xiaomi's MiMo-Code fork.
MIT licensed. Monorepo. v8.0 scaffolded.

## What is this

8 user-visible features (5 carried from v7 + 3 new from MiMo-Code patches/ re-look):

- **F4' Memory + Context Recon 8K** — agent remembers your project across sessions
- **F2 Rules** — safety net for destructive operations
- **F1 Watchdog** — agent auto-recovers from stuck loops
- **F7 Max Mode** — parallel drafts for hard problems
- **Auto-Max triggers** — F1+F2 auto-call F7 when needed
- **Dynamic Workflow** — sandboxed JS for 200+ step tasks
- **Verify skill** — "no completion claims without fresh verification evidence"
- **Compose pack** — 15 ready-made skills (plan/tdd/verify/subagent/etc)

## W5-6: Dynamic Workflow (v0.6.0)

The flagship feature: sandboxed JavaScript workflows for 200+ step orchestrated tasks.

```ts
// .sffmc/workflows/deep-research.ts
export const meta = {
  name: "deep-research",
  description: "Multi-source research with adversarial jury",
  whenToUse: "Use for thorough, cited answers",
  phases: [{title: "Plan"}, {title: "Search"}, {title: "Crosscheck"}, {title: "Report"}],
}

export default async function main(args) {
  const plan = await agent("Break: " + args.question, { schema: PLAN_SHAPE })
  const searches = await parallel(plan.lines.map(line => 
    () => agent(`Search: ${line.topic}`, { schema: HITS_SHAPE })
  ))
  // ... 6 phases total
  return finalReport
}
```

[Full docs → docs/w5-6-dynamic-workflow.md](docs/w5-6-dynamic-workflow.md)
[5 examples → docs/workflow-examples.md](docs/workflow-examples.md)

## Why these features

> "Max Mode improves SWE-Bench Pro by 10-20% at the cost of roughly 4-5 times the token consumption."
> — Xiaomi MiMo-Code blog

**What each feature gives you**:

- **F4' Memory** — the agent remembers your project across sessions. No more "what repo is this?" at session start. Context recon injects a structured summary (memory bank + AGENTS.md + recent chat) before the first tool call.
- **F2 Rules** — safety net. Blocks `rm -rf /`, `DROP TABLE`, `chmod 777`, writes outside project root. Prevents catastrophic mistakes before they happen. Configurable via YAML.
- **F1 Watchdog** — agent stuck in a loop? After 3 failed tools, watchdog kicks in and redirects. No more manually breaking infinite loops.
- **F7 Max Mode** — the 10-20% benchmark gain. 3 parallel drafts + a judge pick the best approach. Costs 4-5× tokens — worth it for hard problems.
- **Auto-Max triggers** — F1+F2 auto-call F7 when needed. You don't toggle Max Mode manually; the agent detects when a problem is hard enough.
- **Dynamic Workflow** — sandboxed JS primitives (`agent()`, `parallel()`, `pipeline()`) for 200+ step tasks. Clone → update libs → refactor → test → open PR — in one session.
- **Verify skill** — "no completion claims without fresh verification evidence." The agent must show test output, lint results, or a diff before claiming done.
- **Compose pack** — 15 ready-made skills (plan / tdd / verify / subagent / etc) ported from MiMo-Code. Drop-in productivity boosts.

Benchmark comparison (source: MiMo-Code blog, June 2026):

| System | Resolved | Coverage | Avg Score |
|---|---|---|---|
| MiMo-Code + MiMo-V2.5-Pro | 82 | 62 | 73 |
| Claude Code + Sonnet 4.6 | 79 | 55 | 69 |

SFFMC ports the features that create this gap — as OpenCode plugins, not a fork.

## Status

v8.0 — W1-W6 shipped. W7 in planning. See `docs/v8-decision.md` for the full cut/ship rationale and `docs/w1-complete.md` for W1 status.

## Repository layout

```
SFFMC/
├── README.md                  # this file
├── LICENSE                    # MIT
├── .gitignore
├── package.json               # bun workspace
├── tsconfig.json              # strict TypeScript
├── docs/
│   ├── v8-decision.md              # what ships, what cuts, why
│   ├── migration-from-opencode.md  # migration guide
│   ├── w1-complete.md              # W1 status (shipped Jun 14)
│   ├── w5-6-dynamic-workflow.md    # Workflow engine design doc
│   └── workflow-examples.md        # 5 copy-pasteable workflow examples
├── packages/                       # one feature plugin per dir
│   ├── memory/                     # @sffmc/memory (F4')
│   ├── rules/                      # @sffmc/rules (F2)
│   └── workflow/                   # @sffmc/workflow (W5-6)
└── shared/                    # shared types and utilities
    └── .gitkeep
```

## License

MIT
