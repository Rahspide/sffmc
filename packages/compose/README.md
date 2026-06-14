# @sffmc/compose — Compose Mode Skills for SFFMC v8.0

Loads MiMo-Code Compose Mode skills on demand via an OpenCode plugin. Each skill is a markdown document that agentic workflows can inject into their context with a single tool call.

## Install

1. **No dependencies** — the package uses only Node.js built-ins (`node:fs/promises`, `node:path`).

2. **Add to your OpenCode sandbox `plugin[]`:**

```json
{
  "plugin": [
    "file:///data/projects/SFFMC/packages/compose/src/index.ts"
  ]
}
```

3. Restart the sandbox service:

```bash
sudo systemctl restart opencode-sandbox.service
```

## How agents use it

The plugin registers a single tool: `compose_skill`.

An agent calls:

```
compose_skill({ name: "verify" })
```

The tool returns the full markdown content of the requested skill. The agent then
processes the skill text as a system prompt augment (or reads it to follow its
instructions).

Token cost is zero unless a skill is explicitly loaded. No skills are pre-loaded.

## Skills

| Skill | Lines | Description |
|-------|-------|-------------|
| `ask` | ~59 | Decision routing — uses `question` tool, handles `[Never-Ask]` fallback |
| `brainstorm` | ~221 | Design gate — HARD-GATE for user approval before implementation |
| `debug` | ~298 | Systematic 4-phase debugging — root cause before fixes |
| `execute` | ~72 | Plan execution with review checkpoints |
| `feedback` | ~215 | Code review reception — verify before implementing |
| `merge` | ~253 | Branch completion — 4 options: merge/PR/keep/discard |
| `new-skill` | ~655 | Meta-skill — TDD for skill documentation |
| `parallel` | ~183 | Dispatch parallel agents for independent tasks |
| `plan` | ~162 | Task decomposition with `[S1]`/`[S2]` spec anchors |
| `report` | ~181 | Final report writing — accumulated specs → single report |
| `review` | ~105 | Code review dispatch — reviewer subagent templates |
| `subagent` | ~345 | Two-stage review with implementer + spec-reviewer + code-quality-reviewer |
| `tdd` | ~373 | Test-Driven Development with anti-rationalization tables |
| `verify` | ~141 | "No completion claims without fresh verification evidence" |
| `worktree` | ~234 | Git worktree isolation — detect/create/cleanup |

## Kill Criteria (why this package exists)

SFFMC v8.0 is a **discipline overlay** for OpenCode. These 15 skills are the
foundation: they teach agents to plan before coding, verify before claiming,
review before merging, and trace root causes before fixing. Without the compose
skills, SFFMC is just a collection of reactive hooks — the skills provide the
*proactive* half: when to start, what to check, how to verify.

## License

Each skill file is copied verbatim from
[XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) (commit `42e7da3`,
2026-06-11). The skills retain their upstream license attribution — see the
MiMo-Code repository for full license terms. MiMo-Code is a fork of OpenCode
under the MIT license.

The SFFMC plugin wrapper (`src/index.ts`, `src/index.test.ts`) is MIT.
