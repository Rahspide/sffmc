# SFFMC — Some Features From MiMo Code

OpenCode plugin suite porting killer features from Xiaomi's MiMo-Code fork.
MIT licensed. Monorepo. v0.7.0 shipped.

## What is this

10 packages, 272 tests passing. Killer features from MiMo-Code, ported as standalone OpenCode plugins:

- **F4' Memory + Context Recon 8K** — agent remembers your project across sessions
- **F2 Rules** — safety net for destructive operations
- **F1 Watchdog** — agent auto-recovers from stuck loops
- **F7 Max Mode** — parallel drafts for hard problems
- **Auto-Max triggers** — F1+F2 auto-call F7 when needed
- **Dynamic Workflow** — sandboxed JS for 200+ step tasks (5 builtins: deep-research, plan, tdd, refactor, +custom)
- **Verify skill** — "no completion claims without fresh verification evidence"
- **Compose pack** — 15 ready-made skills (plan/tdd/verify/subagent/etc)
- **EOS stripper** + **Log whitelist** — local-model survival + log hygiene
- **@sffmc/shared** — opt-in SDK (loadConfig, PluginContext, EventBus) for plugin authors

## Quick start

```bash
# 1. Add the SFFMC plugins to your OpenCode config (~/.config/opencode/opencode.json):
#    "plugin": [ ..., "file:///path/to/SFFMC/packages/memory/src/index.ts", ... ]
#
# 2. (Optional) add the shared SDK to your package.json workspaces:
#    "workspaces": ["packages/*", "shared"]
#
# 3. (Optional) use workflow builtins:
#    workflow({ operation: "run", name: "deep-research", args: { question: "..." } })

# Run all tests
bun test

# Build all plugins to /tmp/sffmc-build
bun run build

# Type-check
bun run typecheck
```

→ Full setup walkthrough: **[docs/getting-started.md](docs/getting-started.md)**

## W5-6: Dynamic Workflow (v0.6.0+)

The flagship feature: sandboxed JavaScript workflows for 200+ step orchestrated tasks. Quickjs-emscripten WASM provides true isolation. 5 builtins ready:

- **deep-research** (6 phases) — adversarial jury validates every fact
- **plan** (4 phases) — produces a structured 5-step plan
- **tdd** (5 phases) — generates test + implementation as artifacts
- **refactor** (4 phases) — proposes before/after patches, never auto-applies
- **custom** — `export const meta = {...}` in any `.ts` file under `.sffmc/workflows/`

```ts
// .sffmc/workflows/deep-research.ts (built-in example)
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
[Architecture review → docs/w5-6-architecture-review.md](docs/w5-6-architecture-review.md)

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
- **EOS stripper** — local models (Ollama, vLLM, oMLX) emit `<|im_end|>` etc. and die in agent loops. This strips them.
- **Log whitelist** — prevents 12GB permission-log spam from 30-day daemon runs.

Benchmark comparison (source: MiMo-Code blog, June 2026):

| System | Resolved | Coverage | Avg Score |
|---|---|---|---|
| MiMo-Code + MiMo-V2.5-Pro | 82 | 62 | 73 |
| Claude Code + Sonnet 4.6 | 79 | 55 | 69 |

SFFMC ports the features that create this gap — as OpenCode plugins, not a fork.

## Status

| Version | Date | Highlights |
|---|---|---|
| **v0.7.0** | 2026-06-15 | + 3 workflow builtins (plan, tdd, refactor), @sffmc/shared SDK, 9 per-plugin READMEs, getting-started guide |
| v0.6.1 | 2026-06-15 | Load order audit (0 conflicts, 9/9 plugins verified) |
| v0.6.0 | 2026-06-15 | Dynamic Workflow engine + deep-research builtin, 9 SFFMC plugins shipped, 96 tests |
| v0.5.0 | 2026-06-14 | Compose pack (15 skills from MiMo-Code) |
| v0.4.0 | 2026-06-14 | Max Mode + Auto-max (7 plugins) |
| v0.3.0 | 2026-06-14 | Watchdog + EOS stripper + log whitelist |
| v0.2.0 | 2026-06-14 | Memory + Context Recon + Rules |

See [CHANGELOG.md](CHANGELOG.md) for full release notes and [docs/v8-decision.md](docs/v8-decision.md) for the cut/ship rationale.

## Repository layout

```
SFFMC/
├── README.md
├── CHANGELOG.md
├── LICENSE                         # MIT
├── package.json                    # bun workspace
├── tsconfig.json                   # strict TypeScript
├── docs/
│   ├── getting-started.md          # first-workflow walkthrough
│   ├── v8-decision.md              # what ships, what cuts, why
│   ├── w5-6-dynamic-workflow.md    # Workflow engine design doc
│   ├── workflow-examples.md        # 5 copy-pasteable examples
│   ├── load-order-audit.md         # hook conflict analysis
│   ├── import-from-mimo.md         # W4 feature mapping
│   └── migration-from-opencode.md # migration guide
├── packages/                       # 9 feature plugins
│   ├── memory/                     # @sffmc/memory (F4')
│   ├── rules/                      # @sffmc/rules (F2)
│   ├── watchdog/                   # @sffmc/watchdog (F1)
│   ├── eos-stripper/               # @sffmc/eos-stripper
│   ├── log-whitelist/              # @sffmc/log-whitelist
│   ├── max-mode/                   # @sffmc/max-mode (F7)
│   ├── auto-max/                   # @sffmc/auto-max
│   ├── compose/                    # @sffmc/compose (15 skills)
│   └── workflow/                   # @sffmc/workflow (5 builtins)
├── shared/                         # @sffmc/shared SDK (opt-in)
└── scripts/
    └── audit-load-order.py         # AST-based hook auditor
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Each plugin is a standalone TypeScript module with its own README, tests, and changelog entry.

## Publishing

See [RELEASE.md](RELEASE.md) for the per-plugin publish checklist (no remote currently configured; v0.7.0 is local-only).

## License

MIT
