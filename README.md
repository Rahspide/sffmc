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

## Status

v8.0 — scaffolded. Features not yet implemented. See `docs/v8-decision.md` for the full cut/ship rationale.

## Repository layout

```
SFFMC/
├── README.md                  # this file
├── LICENSE                    # MIT
├── .gitignore
├── package.json               # bun workspace
├── tsconfig.json              # strict TypeScript
├── docs/
│   └── v8-decision.md         # what ships, what cuts, why
├── packages/                  # one directory per feature plugin
│   └── .gitkeep
└── shared/                    # shared types and utilities
    └── .gitkeep
```

## License

MIT
