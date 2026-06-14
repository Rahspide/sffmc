# @sffmc/watchdog

Detects when the agent is stuck in a tool-failure loop and auto-promotes to a stronger reasoning mode.

## What it does

Monitors all tool calls via `tool.execute.after`. When the same tool+errorType combination fails 3 times consecutively (configurable), it injects a "promotion" instruction into the next system prompt, telling the agent to slow down, double-check paths, and try alternative approaches. When the tool finally succeeds, it injects a recovery verdict confirming the resolution.

**Example scenario:**
1. Agent runs `bash: cat /nonexistent/file` → ENOENT
2. Agent retries with same path → ENOENT again
3. Agent retries again → ENOENT third time
4. Watchdog promotes → injects "Stuck detected on `bash:ENOENT`" instruction
5. Agent runs `ls /nonexistent/` first, finds correct path, succeeds
6. Watchdog injects recovery verdict

## Install

```bash
cp packages/watchdog/config/watchdog.example.yaml ~/.config/SFFMC/watchdog.yaml
```

Add to your opencode.json `plugin` array:
```json
"file:///data/projects/SFFMC/packages/watchdog/src/index.ts"
```

## Token cost

- **Baseline**: 0 tokens (pure event observer)
- **Recovery verdict**: ~30 tokens injected into output
- **Promoted turn**: ~200 tokens injected into system prompt
- **/max escape hatch**: free

## Kill criteria

Decommision this plugin if:
- < 5 auto-promotions in 30 days AND
- User still uses `/max` manually > 20 times/month
