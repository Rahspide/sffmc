# Auto-Max Triggers

Auto-invokes F7 Max Mode when the F1 Watchdog detects a tool stuck in a failure loop.

## How it works

1. Monitors tool execution failures (same signals watchdog uses: error output strings, metadata error flags)
2. When the same tool fails N consecutive times (configurable, default 3), auto-triggers Max Mode
3. Max Mode generates parallel candidates to break the loop
4. Cost cap: only 1 Max Mode invocation per session (configurable)

## Coordination with watchdog + max-mode

- **watchdog** (F1): Detects tool failures, promotes to detailed thinking
- **auto-max** (this plugin): Detects the same failures, triggers Max Mode for parallel candidate generation
- **max-mode** (F7): Generates N candidate solutions, judge picks the best

Auto-max is the bridge: watchdog detects → auto-max decides "this is bad enough for Max Mode" → max-mode executes.

Both watchdog and auto-max operate independently. Watchdog still promotes to detailed thinking. Auto-max adds Max Mode on top when threshold is hit.

## Cost cap rationale

Max Mode is expensive (~3-5× a single call). The cost cap (default: 1 per session) prevents runaway costs. If the agent is stuck on 3 different tools in one session, Max Mode fires once. After that, the agent must use normal reasoning or manual `/max`.

## How to disable

Set `enabled: false` in `~/.config/SFFMC/auto-max.yaml`. Or increase `watchdog_threshold` to a very high number.

## Overhead

~5% baseline overhead. Only fires when tool failure threshold is hit, not on every tool call.
