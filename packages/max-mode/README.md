# F7 Max Mode

Parallel candidate generation + judge selection for hard problems. Invoke via `/max` slash command.

## How it works

1. `/max` generates N candidates (default 3) in parallel, each with the same prompt at a different temperature
2. Candidates suggest tool calls but **do not execute them** — tools are schema-only during candidate generation
3. A separate judge call evaluates all candidates and picks the best
4. The winning draft + suggested tool calls are presented
5. User must **confirm** (via `/max execute`) before tool calls are actually executed

## Token cost

- ~3-5× a single call (depending on `n_candidates`)
- Judge adds ~1 small call
- Configurable cap via `budget_cap_multiplier`

## Schema-only tools pattern

Why don't candidates execute tools? OpenCode 1.17.6 has no `stopStep` mechanism to block tool execution mid-generation. Instead, Max Mode strips the `execute` closure from tool definitions during candidate generation. The model sees tool schemas (so it reasons about tool usage) but can't actually run them.

This means:
- Candidates complete in one pass (no tool loop)
- Only the winner's suggested tool calls are surfaced for review
- The judge evaluates text quality, not tool execution results

## When to use

- Complex multi-step problems where you want diverse approaches
- Debugging where different AI takes on a problem are valuable
- Architecture decisions where exploring alternatives is beneficial
- Any task where quality matters more than speed

## Dry-run

`/max --dry-run` estimates cost without generating anything.

## Benchmarks

Max Mode achieves **10-20% improvement on SWE-Bench Pro at 4-5× cost** compared to single-model baseline.

See: MiMo-V2.5-Pro scores: 82/62/73 (MiMo+V2.5-Pro) vs 79/55/69 (Claude Code+Sonnet 4.6).
