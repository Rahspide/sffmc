# Migration Between OpenCode, MiMo-Code, and SFFMC

SFFMC is a plugin suite for OpenCode that ports the killer features from Xiaomi's MiMo-Code fork. If you use any of these three, here's how to move between them.

## What's the Same

OpenCode, MiMo-Code, and SFFMC all share the same engine:

- **Agent loop** - user prompt → tool calls → response → repeat
- **TUI** - terminal-based interface with session management
- **Plugin system** - OpenCode hooks (`tool.execute.before`, `experimental.chat.messages.transform`, `permission.ask`)
- **Providers** - Anthropic, OpenAI, Google, DeepSeek, and any OpenAI-compatible
  custom API endpoint
- **MCP servers** - same protocol, same JSON-RPC transport
- **Session persistence** - SQLite-backed session history

If you know one, you know all three. The differences are in what gets injected into the agent's context **before** it runs.

## What's Different

| Feature | vanilla OpenCode | MiMo-Code (fork) | SFFMC (plugin suite) |
|---|---|---|---|
| **Memory** | No | Built-in (hardcoded) | Plugin (`@sffmc/memory`) |
| **Rules** | No | Built-in (hardcoded) | Plugin (`@sffmc/safety`) |
| **Watchdog** | No | Built-in (hardcoded) | Plugin (`@sffmc/safety`) |
| **Max Mode** | No | Built-in (hardcoded) | Plugin (`@sffmc/cognition`) |
| **Auto-Max triggers** | No | Built-in (hardcoded) | Plugin (`@sffmc/safety`) |
| **Dynamic Workflow** | No | Built-in (hardcoded) | Plugin (`@sffmc/runtime`) |
| **Verify skill** | No | Built-in (hardcoded) | Plugin (`@sffmc/cognition`) |
| **Compose pack** | No | Built-in (hardcoded) | Plugin (`@sffmc/cognition`) |
| **EOS token stripping** | No | PR #603 (pending) | Plugin (`@sffmc/safety`) |
| **Log whitelist** | No | PR #604 (pending) | Plugin (`@sffmc/safety`) |

MiMo-Code built these features directly into the fork - they're always on, always consuming resources. SFFMC ships them as **plugins** - you enable only what you need.

## Migration Paths

### 1. OpenCode → SFFMC

**When**: You want memory, rules, and Max Mode without switching to a fork.

**Time**: ~5 minutes.

```
# 1. Install Bun (if not present)

curl -fsSL https://bun.sh/install | bash

# 2. Clone SFFMC

git clone https://github.com/YOUR_USER/SFFMC.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc

# 3. Install dependencies

bun install

# 4. Add plugins to opencode.json

# Edit ~/.config/opencode/opencode.json, add to plugin[]:

# {
#   "file": "~/.sffmc/plugins/sffmc/packages/memory/src/index.ts",
#   "enabled": true
# },
# {
#   "file": "~/.sffmc/plugins/sffmc/packages/safety/src/rules/index.ts",
#   "enabled": true
# }

# 5. Restart OpenCode

# DO NOT restart from the OpenCode web UI - restart via SSH or your service manager:
#   Linux/systemd:    sudo systemctl restart opencode
#   Linux/manual:     pkill -f opencode && /usr/local/bin/opencode serve &
#   macOS/launchd:    launchctl kickstart -k gui/$(id -u)/com.opencode
#   Or stop the opencode process from your process manager and start it again.
```

**What you get immediately**:
- Memory starts watching `memory-bank/` and `AGENTS.md`, building a searchable index
- Rules blocks `rm -rf /`, `DROP TABLE`, `chmod 777`, and writes outside project root by default
- Both plugins auto-load, no config files needed

**What you don't get yet** (in later releases):
- Watchdog, Max Mode, Dynamic Workflow, Compose pack, Verify skill (all 5 are SFFMC builtins - pick the matching name from `sffmc/workflow` or `sffmc/compose`)

### 2. SFFMC → OpenCode

**When**: You want to return to vanilla OpenCode.

```
# 1. Remove plugin entries from opencode.json

# Delete the @sffmc/memory and @sffmc/safety blocks from plugin[]

# 2. (Optional) Remove config files

rm -rf ~/.config/sffmc/

# 3. (Optional) Remove memory database

rm -f ~/.local/share/sffmc/memory/index.sqlite*

# 4. Restart OpenCode
```

**What you lose**: Memory, rules, and any in-progress sessions that depended on context recall blocks. Your OpenCode sessions return to default behavior immediately.

### 3. OpenCode → MiMo-Code

**When**: You want all 8 features now, as a single binary, and are OK with a fork.

```
# 1. Save your current sessions

cp ~/.local/share/opencode/opencode.db ~/opencode.db.bak-opencode-$(date +%Y%m%d)

# 2. Install MiMo-Code

# Follow Xiaomi's install guide: https://mimo.xiaomi.com/mimo-code/start
# MiMo-Code replaces your OpenCode binary with its fork

# 3. Copy sessions (if compatible)

# MiMo-Code may or may not read OpenCode's session DB.
# Check Xiaomi's migration docs.
```

**Risks**: MiMo-Code is a full fork - it may diverge from upstream OpenCode. Your plugins that worked on OpenCode may break on MiMo-Code if the hook API changes. Check the upstream issue tracker for current bug count before migrating.

### 4. MiMo-Code → SFFMC

**When**: You use MiMo-Code for its features but want to stay on upstream OpenCode.

```
# 1. Uninstall MiMo-Code

# Follow Xiaomi's uninstall guide. This typically means:
# - Reverting to the official OpenCode binary
# - Restoring your original opencode.json

# 2. Install OpenCode

# Follow the official OpenCode install guide

# 3. Migrate sessions (if possible)

# MiMo-Code session format may differ. Try:
cp ~/.local/share/mimo/mimo.db ~/.local/share/opencode/opencode.db
# If OpenCode doesn't read it, you'll start fresh.

# 4. Install SFFMC plugins (see "OpenCode → SFFMC" above)
```

**What you keep**: Memory (starts fresh in SFFMC - MiMo-Code's memory format is different), Rules (SFFMC rules are YAML, customizable), Max Mode (`/max` command), all 7 built-in workflows (`deep-research`, `plan`, `tdd`, `refactor`, `security-audit`, `doc-gen`, `lib-migrate`). All shipped in v0.16.0.

## The 5 Issues to Know (Round 6 Must-Adds)

Based on research of OpenCode community issues (5+ per day as of June 2026).

### 1. EOS Token Stripping for Local Models

**Problem**: Some local models (Ollama, vLLM, oMLX) emit end-of-sequence tokens mid-stream - `</s>`, `<|endoftext|>`, `<|im_end|>`, etc. When the agent sees these tokens, it interprets them as "conversation finished" and exits the loop after a single tool call. Your long-running task fails quickly.

**What SFFMC does**: EOS stripper plugin sits on `experimental.text.complete` and strips 10 known EOS token patterns from the end of model output before the agent loop sees them. See `packages/safety/src/eos-stripper/patterns.ts:DEFAULT_EOS_PATTERNS` for the canonical list.

```
# EOS tokens we strip (matches DEFAULT_EOS_PATTERNS):
</s>
<|endoftext|>
<|im_end|>
<|eot_id|>
<|end|>
<|end_of_turn|>
<|endofmessage|>
<|return|>
[/INST]
<end_of_utterance>
```

### 2. Debounce Tool Calls

**Problem**: Agent fires 10 `read` calls in a row without waiting for user confirmation. You get 10 file contents you didn't ask for, drowning the thread.

**What SFFMC does**: Tool debounce hook counts consecutive same-tool calls. When count exceeds threshold (default 3), blocks until user explicitly allows. Not shipped yet.

### 3. 200K Default Context

**Problem**: OpenCode's default context window is too small for 200+ step tasks. Compaction fires too early or too late - you lose important context or waste tokens on irrelevant history.

**What SFFMC does** (advisory): Memory thresholds calibrated for 200K context (20/45/70% instead of 40/80%). Compaction triggers earlier, preserving more context for long tasks. PR #609 provides the baseline calibration.

### 4. Small Log Entries (Permission Log Spam)

**Problem**: OpenCode's permission system logs every ask/deny decision verbatim. 12 GB of log files in 30 days from `permission.ask` spam. Debugging becomes slow because the actual error is buried in 400 MB of identical "user agreed" entries.

**What SFFMC does**: Rules log whitelist - logs only deny decisions and unexpected states. Allow decisions are silent. Ask decisions are batched. PR #604 from MiMo-Code provides the whitelist approach.

### 5. OpenCode-Migration Guide

**Problem**: Users porting between OpenCode and MiMo-Code hit identical issues every day (5+ GitHub issues). Same questions: "Where's my memory?", "Why did my rules disappear?", "How do I get Max Mode back?".

**What SFFMC does**: This document. Plus the "Import from MiMo" guide that maps every MiMo-Code feature to its SFFMC equivalent.

## Risks

### Plugin Slot Conflicts

SFFMC plugins use standard OpenCode hooks (`tool.execute.before`, `permission.ask`, `experimental.chat.messages.transform`). If you already have a plugin on the same hook, they stack in load order. Rules:
- `tool.execute.before` - all plugins fire in sequence. If any throws, the tool is blocked. Safe to stack.
- `permission.ask` - last plugin to set `status.status` wins. Order matters.
- `experimental.chat.messages.transform` - each plugin transforms the output of the previous. Order matters.

**Fix**: Put SFFMC plugins first in `plugin[]` array. Memory should load before DCP.

### Hook Ordering

```
# Recommended order in opencode.json plugin[]:

1. @sffmc/memory       (messages.transform - recon injection)
2. @sffmc/safety        (tool.execute.before - safety gate)
3. DCP                  (messages.transform - compaction)
4. Your plugins         (other hooks)
```

Memory must inject recon **before** DCP compacts - otherwise DCP sees stale messages. Rules must gate **before** other tool hooks - otherwise a later plugin might bypass the safety net.

### DCP Tuning When Adding Memory

Memory injects ~32KB of context recon at session start. If DCP's compaction threshold is at 40%, this pushes you closer to it. Adjust DCP thresholds:

```
# dcp.jsonc - add at least 5% buffer
{
  "compactionThreshold": 0.75,  // was 0.70
  "nudgeFrequency": 60,         // was 50
}
```

### bun:sqlite vs node:sqlite

SFFMC's memory plugin uses a runtime guard - it detects your JavaScript engine and loads the right SQLite backend:

```
Bun runtime    → bun:sqlite (3-6x faster)
Node 22.6+     → node:sqlite/DatabaseSync (built-in, no native deps)
```

The adapter normalizes both backends to the same API (`db.query(sql).all()`, `db.query(sql).get()`, `db.run(sql, [params])`). You don't need to install `better-sqlite3` or any native module. No `node-gyp` build step. No platform-specific binaries.

If you develop on Bun and deploy on Node, the same code works on both. The adapter handles the `.run()` parameter normalization (bun:sqlite spreads arrays, node:sqlite requires `.prepare().run()`).

## Sanity Checks

After migrating, verify everything works:

```
# 1. Memory plugin: check DB was created

ls -la ~/.local/share/sffmc/memory/index.sqlite
# Should exist with non-zero size

# 2. Memory plugin: check watcher is indexing

# Create a test file in your project
echo "# Test" >> memory-bank/test.md
# Wait 1 second, then check DB
sqlite3 ~/.local/share/sffmc/memory/index.sqlite "SELECT count(*) FROM memory_entries"
# Should be > 0

# 3. Rules plugin: check default rules loaded

# The plugin should load defaults if ~/.config/sffmc/rules.yaml doesn't exist.
# Verify by running a dangerous command - it should be blocked:
# "rm -rf /" → DENIED
# "DROP TABLE users" → DENIED
# "sudo systemctl stop nginx" → WARNING (ask)

# 4. Check hooks are active

# Start a new OpenCode session. System message should contain:
# "[Context Recon 8K - injected by Memory]"
# If you see this, memory is working.

# 5. Test path outside protection

# Ask the agent: "write to /etc/passwd"
# Should be DENIED with reason: "path outside PROJECT_ROOT"

# 6. Run the test suite

cd ~/.sffmc/plugins/sffmc
bun test
# Should show: 1130 tests, 0 failures (74 files)
```

## References

- [MiMo-Code PR #603](https://github.com/XiaomiMiMo/MiMo-Code/pull/603) - EOS token stripping patterns
- [MiMo-Code PR #604](https://github.com/XiaomiMiMo/MiMo-Code/pull/604) - permission log whitelist
- [MiMo-Code PR #609](https://github.com/XiaomiMiMo/MiMo-Code/pull/609) - 200K context calibration
- [MiMo-Code issue #472](https://github.com/XiaomiMiMo/MiMo-Code/issues/472) - voice control contradiction (do not claim)
- [MiMo-Code issue #607](https://github.com/XiaomiMiMo/MiMo-Code/issues/607) - macOS IPC bug (Linux-only is honest)
- [MiMo-Code official docs](https://mimo.xiaomi.com/mimo-code/start)
