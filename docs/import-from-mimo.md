# Import from MiMo-Code to SFFMC v0.9.0

Guide for migrating settings, skills, and configuration from
[MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) to
[SFFMC](https://github.com/settingsfuck/SFFMC) v0.9.0.

## What is MiMo-Code

[MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) is a fork of OpenCode
(formerly Claude Code) with extended features: multi-agent orchestration,
Compose Mode (15 structured workflow skills), a built-in visual companion
for design brainstorming, and Chinese-language UI support. It runs as a
full application with its own launch configuration, key management, and
plugin ecosystem.

## What is SFFMC

[SFFMC v0.9.0](https://github.com/settingsfuck/SFFMC) is a **discipline overlay**
plugin pack for vanilla OpenCode 1.17.6. It does NOT fork or replace OpenCode
— it injects hooks (rules enforcement, log filtering, error detection,
auto-max-mode escalation, multi-model council, and the Compose Mode skills)
as OpenCode-compatible plugins. You install SFFMC by adding `file://` plugin
paths to your `opencode.json`.

Key difference: **MiMo-Code is a platform. SFFMC is a plugin layer on top of
the upstream OpenCode platform.**

## Feature Mapping

| MiMo-Code Feature | SFFMC v0.9.0 Equivalent | Status |
|---|---|---|
| Compose Mode (15 skills) | `@sffmc/compose` package — `compose_skill` tool | ✅ v0.9.0 |
| Multi-agent orchestration (actor/task tools) | Not replicated — use OpenCode's native background agents + slim v2 scheduler | N/A |
| Visual companion (browser-based mockups) | Not replicated — deferred to v8.1+ | ❌ |
| Agent presets (cheap/powerful/etc) | Not replicated — use OpenCode per-agent model config | N/A |
| Built-in Chinese UI | Not applicable — SFFMC is headless, UI is upstream OpenCode desktop | N/A |
| MiMo-specific model routing | 9Router gateway (4 provider endpoints at `:20129`-`:20132`) | ✅ Separate |
| MiMo config system (`.mimocode/`) | `~/.config/SFFMC/` YAML configs (rules, watchdog, auto-max, eos, log, memory) | ✅ v0.9.0 |
| Rules enforcement (deny write outside project) | `@sffmc/rules` — gate-based allow/deny | ✅ v0.9.0 |
| Watchdog (failure detection) | `@sffmc/watchdog` — threshold-based error escalation | ✅ v0.9.0 |
| Auto-max-mode (3-strikes escalation) | `@sffmc/auto-max` + `@sffmc/max-mode` | ✅ v0.9.0 |
| EOS stripper | `@sffmc/eos-stripper` | ✅ v0.9.0 |
| Log whitelist filter | `@sffmc/log-whitelist` | ✅ v0.9.0 |
| Memory system (ICM) | `@sffmc/memory` + ICM MCP server | ✅ v0.9.0 |
| Multi-model council | Built-in council agent (minimax/MiniMax-M3 + councillor subagents) | ✅ v0.9.0 |

### Deferred to v8.1+

| Feature | Reason |
|---|---|
| Visual companion (browser mockups) | Requires playwright with `--host 0.0.0.0` + browser orchestration — design work needed |
| Compose Mode subagent templates (implementer-prompt.md, spec-reviewer-prompt.md, code-quality-reviewer-prompt.md) | These are reference templates used by the `subagent` skill — present in skill content but not wired as standalone tools |
| Chinese UI localization | SFFMC is English-only; MiMo UI is a full fork concern |
| Agent presets (`/preset cheap`) | OpenCode 1.17.6 doesn't have runtime preset switching — per-agent model config is sufficient |

## Migration Steps

### 1. Copy your MiMo config to SFFMC

MiMo stores config in `~/.mimocode/` (or the project's `.mimocode/`).
SFFMC uses `~/.config/SFFMC/`.

```bash
# If you have MiMo config files:
cp -r ~/.mimocode/*.yaml ~/.config/SFFMC/
# Or just the ones you customized:
cp ~/.mimocode/rules.yaml ~/.config/SFFMC/
cp ~/.mimocode/watchdog.yaml ~/.config/SFFMC/
```

**Note:** MiMo uses a different config format in some areas. Check each file:

| MiMo File | SFFMC Equivalent | Changes Needed |
|---|---|---|
| `rules.yaml` | `rules.yaml` | Same format — copy as-is |
| `watchdog.yaml` | `watchdog.yaml` | Same format — copy as-is |
| `auto-max.yaml` | `auto-max.yaml` | Same format — copy as-is |
| `eos.yaml` | `eos.yaml` | Same format — copy as-is |
| `log.yaml` | `log.yaml` | Same format — copy as-is |

SFFMC configs all live flat in `~/.config/SFFMC/` — no nested directories.

### 2. Update provider URLs

MiMo-Code routes through its own API gateway (typically at a MiMo-hosted
endpoint). SFFMC uses **9Router** as the AI gateway, running locally:

```bash
# 9Router is at 127.0.0.1:20128 (or 192.168.1.134:20128 on LAN)
# Provider endpoints:
#   ocg → 127.0.0.1:20130/v1 (DeepSeek, GLM, Kimi, Qwen, MiniMax via prefix-proxy)
#   minimax → 127.0.0.1:20129/v1 (MiniMax native)
#   cx → 127.0.0.1:20131/v1 (Codex/GPT)
#   gemini → 127.0.0.1:20132/v1 (Gemini)
```

**Action:** Check your `~/.config/opencode/opencode.json` (or equivalent
OpenCode config). If you have MiMo-specific provider URLs (e.g., `https://api.mimo.xxx/...`),
replace them with the 9Router endpoints above. The sandbox config at
`/home/opencode/.config/opencode-sandbox/opencode/opencode.json` has a
working reference.

```json
{
  "provider": {
    "ocg": {
      "name": "ocg",
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://127.0.0.1:20130/v1" },
      "apiKey": "sk-6b99ddb4183dcb1b-qqv6s5-30baf6e4"
    }
  }
}
```

### 3. Map agent names

MiMo-Code has its own agent naming convention. SFFMC uses OpenCode's native
agent system with these additions:

| MiMo Agent | SFFMC Equivalent | Notes |
|---|---|---|
| Primary agent (default) | `orchestrator` (model: `minimax/MiniMax-M3`) | SFFMC orchestrator is a workflow manager |
| Explorer | `explorer` (model: `ocg/deepseek-v4-flash`) | Read-only code recon |
| Librarian | `librarian` (model: `minimax/MiniMax-M3`) | External research |
| Fixer | `fixer` (model: `ocg/deepseek-v4-pro`) | Implementation specialist |
| Oracle | `oracle` (model: `ocg/deepseek-v4-pro`, variant=max) | Strategic advisor |
| Designer | `designer` (model: `minimax/MiniMax-M3`) | UI/UX specialist |
| Council | `council` + `councillor` subagents | Multi-model consensus |
| PAL Specialist | `pal-specialist` (variant=max) | On-demand PAL tools |

Model selection: SFFMC uses `ocg/deepseek-v4-flash` as the default (cheap,
fast) and `ocg/deepseek-v4-pro` for complex tasks. MiMo's default model may
differ — adjust per-agent models in your config.

### 4. Drop MiMo-specific hook configs

MiMo-Code has additional hook configuration that SFFMC doesn't use:

- **`hooks/` directory**: MiMo has a hooks subsystem for pre/post tool execution.
  SFFMC equivalents are built into the plugin hooks (`tool.execute.after`,
  `experimental.text.complete`) — no separate hook config needed.
- **Compose Mode activation**: In MiMo, Compose Mode must be explicitly activated
  (`/compose` or auto-activation). In SFFMC, the `compose_skill` tool is always
  available — agents call it on demand.
- **Visual companion config**: Not in SFFMC v0.9.0. Remove any `visual-companion`
  settings.

**Safe to drop:**
- Any `hooks/` directory content
- Compose Mode activation flags
- Visual companion preferences (deferred to v8.1+)
- MiMo-specific model names not in 9Router's catalog

### 5. Plugin list migration

MiMo plugins are separate from SFFMC plugins. If you have custom MiMo plugins,
they need to be ported to the OpenCode 1.17.6 plugin shape (see existing SFFMC
packages for the pattern). The SFFMC plugin list in the sandbox includes:

```
file:///data/projects/SFFMC/packages/memory/src/index.ts
file:///data/projects/SFFMC/packages/rules/src/index.ts
file:///data/projects/SFFMC/packages/watchdog/src/index.ts
file:///data/projects/SFFMC/packages/eos-stripper/src/index.ts
file:///data/projects/SFFMC/packages/log-whitelist/src/index.ts
file:///data/projects/SFFMC/packages/max-mode/src/index.ts
file:///data/projects/SFFMC/packages/auto-max/src/index.ts
file:///data/projects/SFFMC/packages/compose/src/index.ts
```

8 SFFMC plugins total. Add the compose plugin as the 8th entry.

## Sanity Checks

After migration, verify everything works:

### 1. Check sandbox health

```bash
curl -s http://127.0.0.1:4200/global/health
# Expected: {"status": "healthy"}
```

### 2. Verify SFFMC plugins loaded

```bash
curl -s http://127.0.0.1:4200/config | python3 -c "
import json,sys
c = json.load(sys.stdin)
plugins = c.get('plugin', [])
sffmc = [p for p in plugins if 'SFFMC' in p]
print(f'{len(sffmc)} SFFMC plugins loaded')
for p in sffmc:
    print(f'  {p}')
"
# Expected: 8 SFFMC plugins loaded
```

### 3. Check journal for errors

```bash
journalctl -u opencode-sandbox --no-pager -n 20 | grep -i error
# Expected: no output (or only pre-existing non-plugin errors)
```

### 4. Test compose_skill tool

From within an OpenCode session, call:
```
compose_skill({ name: "verify" })
```
Expected: Returns the full verify.md content (starts with `<!-- Copied verbatim`).

### 5. Verify skill content integrity

```bash
cd /data/projects/SFFMC/packages/compose
bun test
# Expected: all 19 tests pass (14 file integrity + 5 plugin smoke)
```

## Common Pitfalls

### "I see the compose skills but they don't activate"

The compose skills are **not auto-loaded**. The agent must explicitly call
`compose_skill({ name: "tdd" })` to load a skill. This is by design — token
cost is zero until a skill is needed.

### "The sandbox has fewer plugins than prod"

The SFFMC sandbox runs on `:4200` with a dedicated `opencode-sandbox.service`.
The production service at `:4100` has a different config. SFFMC plugins are
currently sandbox-only (`/home/opencode/.config/opencode-sandbox/opencode/opencode.json`).
Do NOT modify the production config (`/home/opencode/.config/opencode/opencode.json`).

### "Plugin failed to load — file not found"

Make sure the path in `plugin[]` points to an absolute path that exists:
```bash
ls -la /data/projects/SFFMC/packages/compose/src/index.ts
```

### "compose_skill tool not available in agent list"

The plugin registers the tool globally via the `tool` hook. All agents that can
call tools can use it. If the tool isn't appearing, check:
1. Plugin is in the `plugin[]` array
2. Service was restarted after adding the plugin
3. No load errors in `journalctl`

## When NOT to Migrate

Stay on MiMo-Code instead of migrating to SFFMC if:

1. **You need the visual companion** — SFFMC v0.9.0 doesn't include browser-based
   mockups and diagrams. This is deferred to v8.1+.

2. **You need the full MiMo agent harness** — SFFMC is a plugin layer on vanilla
   OpenCode. MiMo-Code's actor/task system, agent presets, and Chinese UI are
   not replicated (and are not needed — OpenCode's native systems handle the
   same concerns differently).

3. **You prefer a turnkey solution** — SFFMC requires manual plugin configuration
   and YAML file edits. MiMo-Code is self-contained. If you don't want to manage
   plugin paths and config files, stay on MiMo.

4. **You use MiMo-exclusive features** — If you rely on MiMo-specific tools
   (beyond the compose skills), they won't work in SFFMC without porting.

5. **You're not running OpenCode 1.17.6 on Linux** — SFFMC is developed and
   tested on CachyOS (Arch-based) with systemd. While the plugins themselves
   are portable TypeScript, the service management (`opencode-sandbox.service`)
   assumes systemd.

## Reference

- **MiMo-Code:** https://github.com/XiaomiMiMo/MiMo-Code
- **SFFMC:** https://github.com/settingsfuck/SFFMC
- **Compose skills source:** `packages/opencode/src/skill/compose/.bundle/<name>/SKILL.md`
  in MiMo-Code (commit `42e7da3`, 2026-06-11)
- **SFFMC compose package:** `/data/projects/SFFMC/packages/compose/`
