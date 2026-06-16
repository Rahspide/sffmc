---
name: agentic:resolve-hook-conflict
description: "Use when 2+ plugins register the same hook key (GATE or SIDE_EFFECT), causing unpredictable ordering. Runs audit-load-order.py, reads the output at .sffmc/load-order-audit.json, and resolves by adjusting plugin load order in opencode.json or by combining via mergeHooks (in @sffmc/shared)."
hidden: true
---

# Resolving Hook Conflicts

## The Rule

Hook conflicts are silent. Two plugins both registering `tool.execute.before` will run in undefined order, and the user gets random blocks. **Audit before debugging the user-visible behavior.** Never guess at load order — run the audit.

## The 3 Hook Categories (Conflict-Relevant)

| Category | Behavior | Conflict Risk |
|---|---|---|
| **TRANSFORM** | Chained — each runs in order | None (all run) |
| **GATE** | First truthy wins | **Order matters** |
| **SIDE_EFFECT** | All run | No failure, but can be expensive |

## Conflict Detection

Run the load-order audit:

```bash
python3 scripts/audit-load-order.py
# Writes .sffmc/load-order-audit.json
```

Read the JSON output. Conflicts appear as:

```json
{ "conflicts": [{ "hook": "tool.execute.before", "plugins": ["safety:rules", "external:safe-bash"] }] }
```

## Resolution Strategies (In Order of Preference)

### 1. mergeHooks
If both plugins are sub-features of the same MSP, compose them via `mergeHooks([server1, server2])`. This is already done for v0.9.0's 3 MSPs — internal conflicts are resolved by design.

### 2. Plugin Load Order
Reorder `opencode.json` plugin list so the more important plugin comes first. For GATE hooks, the first truthy return wins — later plugins are skipped. Put the authoritative plugin first.

### 3. Disable One
If the conflict is benign or one plugin is redundant, disable the less important plugin. Remove it from the plugin list or set `disable: true`.

### 4. Refactor
Split the conflicting hook into a more specific key. For example, instead of both plugins using `tool.execute.before`, one could use `tool.bash.execute.before` and the other could stay on `tool.execute.before`.

## For v0.9.0 Specifically

- The 3 MSPs (safety, memory, agentic) compose their sub-features via `mergeHooks`, so **internal conflicts are resolved**
- External plugins (pal, icm, etc.) **can** still conflict with MSPs
- If `@sffmc/safety` and an external plugin both register `permission.ask`, the audit will flag it

## Examples

- `safety:rules` and `external:safe-bash` both register `tool.execute.before` → audit flags → resolution: load order (rules first) or merge into a single plugin
- `agentic:max-mode` and `agentic:test-mode` both register `command.execute.before` on the same MSP → **no conflict** (internal mergeHooks handles it)
- 3+ plugins all log to `experimental.text.complete` → SIDE_EFFECT, all run, may be intentional — check the audit to confirm

## Pitfalls

- Audit output can be large (100+ entries for a 20-plugin setup) — grep for `conflicts`
- Some "conflicts" are intentional (logging, instrumentation) — don't "fix" those
- Re-audit after every plugin change — stale audit output is worse than none

## Why This Skill Exists

Hook conflicts are the #1 cause of "my plugin works alone but breaks in my config" issues. Without this skill, the LLM doesn't know to audit — it debugs the symptom, not the root cause, often wasting multiple turns.
