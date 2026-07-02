# Import from MiMo-Code to SFFMC

If you are coming from Xiaomi's [MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code),
here is what you need to know to move to [SFFMC](https://github.com/Rahspide/sffmc).

## What SFFMC is

SFFMC is a **plugin pack** for vanilla OpenCode. It does not fork OpenCode and it
does not ship its own launch configuration or UI — you install it by adding a few
`file://` plugin entries to your existing `opencode.json` and restart.

SFFMC packages the workflows, safety gates, and memory features that have proven
useful during SFFMC's own development. It targets OpenCode 1.17.x on Linux (systemd
service), macOS, and any platform where Bun runs.

## What SFFMC does not include

- A forked or rebranded OpenCode binary — SFFMC runs in your existing OpenCode
  install as plugins.
- A built-in visual companion or design tool. Anything browser-based stays in
  OpenCode itself (e.g. the playwright MCP if you enable it).
- Agent names or model presets. Configure agents and models in your
  `opencode.json` the way OpenCode documents them — SFFMC does not impose
  its own.
- Localized UI strings. SFFMC's docs and skill content are in English.

## Config files

SFFMC reads its plugin config from `~/.config/SFFMC/` (one YAML file per plugin,
for example `~/.config/SFFMC/watchdog.yaml`). If you previously kept MiMo config
elsewhere, you will need to author SFFMC's YAML files from scratch — the formats
do not share a schema, and SFFMC's defaults are safe to start with.

## Migration

1. **Install SFFMC plugins** in your `opencode.json` (see the root `README.md`
   for the three `file://` lines you add).
2. **Author your SFFMC config files** under `~/.config/SFFMC/`. Start with the
   defaults documented in each package's README; copy values from your old
   MiMo config only if you know what they did.
3. **Restart OpenCode.** Verify the plugins loaded with the `sffmc_health` tool
   in any chat session — it reports load order, hook conflicts, and config
   presence per package.
4. **Migrate workflows incrementally.** The plugin you load first should be
   `safety` (it only adds recovery and gate hooks), then `memory`, then
   `cognition`. Add `workflow` last so the sandbox is opt-in.

## Sanity checks

```bash
# Inside an OpenCode session, call:
sffmc_health({})
# Expected: 9 ok / 0 fail / 0 warn.
```

## When to stay on MiMo

Stay on MiMo-Code if you need any of: the bundled visual companion, agent
presets not exposed by vanilla OpenCode, a Chinese-language UI, or a
self-contained launch configuration that does not require editing
`opencode.json`. SFFMC is a plugin layer; MiMo is a fork.
