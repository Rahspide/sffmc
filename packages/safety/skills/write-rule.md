---
name: safety:write-rule
description: "Use when the user wants to add, change, or remove a safety rule. Rules live in ~/.config/SFFMC/rules.yaml and are hot-reloaded every 1s. Three rule types: tool denylist (block specific tool calls), command denylist (block specific bash commands), and pattern (regex on tool output)."
hidden: true
---

# Writing Safety Rules

## The Rule

NEVER edit `rules.yaml` blindly. First check the current file with `cat ~/.config/SFFMC/rules.yaml`. Then propose the new rule in chat. Only after user approval, write the file.

## Schema (3 Types)

```yaml
# ~/.config/SFFMC/rules.yaml
tool_denylist:
  - tool: "bash"
    when: "args.command matches /rm -rf/"
    message: "Destructive command blocked"

command_denylist:
  - pattern: "git push --force"
    message: "Force push blocked"

output_patterns:
  - pattern: "AKIA[0-9A-Z]{16}"
    message: "Possible AWS key leak"
    action: "redact"  # or "block"
```

## Hot-Reload

Rules plugin uses 1s `setInterval` polling. After writing, the new rule is active within 1–2 seconds. No restart needed.

## Three Pitfalls

1. `tool_denylist` matches on the **tool name**, not the args. Use `when: "args.command matches ..."` to filter by args.
2. `command_denylist` is a flat regex on the **full command string**. Be specific - `rm` alone will match too broadly.
3. `output_patterns` with `action: redact` replaces matches with `<REDACTED>` in tool output. With `action: block`, the entire tool call fails.

## Examples

- "Block all curl POST to non-allowlisted hosts" → add `command_denylist` with `pattern: "curl.*-X POST.*(?!(api\\.example\\.com|localhost))"`
- "Redact my API keys from outputs" → add `output_patterns` with AWS/Stripe/OpenAI key regexes, `action: redact`
- "Prevent git push --force" → add `command_denylist` with `pattern: "git push --force"` (block before it runs)

## Verification

After writing, run `bun test packages/safety/src/rules/` to confirm YAML parses. Then test the rule by attempting the blocked action.

## Why This Skill Exists

Without it, users add rules via ad-hoc edits, often with wrong schema. Centralizes the 3 types + hot-reload + pitfalls.
