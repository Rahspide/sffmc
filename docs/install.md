# Installing SFFMC

SFFMC is a monorepo of OpenCode plugins installed as `file://` entries in
`~/.config/opencode/opencode.json`. The one-liner below clones the repo and
runs `sffmc init` to add the plugin paths automatically.

## Quick install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh
```

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
```

### From source

```bash
git clone https://github.com/Rahspide/sffmc.git ~/.sffmc/plugins/sffmc
cd ~/.sffmc/plugins/sffmc
./install.sh
```

## What the one-liner does

1. Clones `https://github.com/Rahspide/sffmc.git` to `~/.sffmc/plugins/sffmc`
   (or `$SFFMC_INSTALL_DIR` if the env var is set).
2. Runs `sffmc init`, which detects your `opencode.json`, backs it up, and
   adds 4 `file://` entries for the installable plugins: 2 composites
   (`safety`, `memory`) + 2 most-used standalones (`runtime`, `cognition`).
3. Restart OpenCode. Done.

## `sffmc` CLI reference

After install, the `sffmc` CLI is available at `~/.sffmc/plugins/sffmc/bin/sffmc`.
Add it to your `PATH` for convenience:

```bash
export PATH="$HOME/.sffmc/plugins/sffmc/bin:$PATH"
```

| Command | What it does |
|---|---|
| `sffmc init` | Auto-detect config + add 2 composite plugins + 2 standalones (safety, memory, runtime, cognition) |
| `sffmc init --all` | Add all 5 plugin paths (utilities is a library, installed separately via npm if needed) |
| `sffmc init --only p1,p2,...` | Add specific packages (comma-separated names) |
| `sffmc init --yes` | Skip the confirmation prompt |
| `sffmc update` | `git pull --ff-only` + re-run init to sync config |
| `sffmc uninstall` | Remove all SFFMC `file://` entries from opencode.json |
| `sffmc doctor` | Run 9-check diagnostic (`bun run scripts/run-health.ts`) |
| `sffmc path` | Print the install directory |
| `sffmc help` | Show usage |

All `init` variants are **idempotent** - re-running them only adds
missing entries and skips already-present ones.

## Pinning a specific version

By default the one-liner installs the `main` branch. Pin a version with
the `SFFMC_VERSION` env var:

```bash
SFFMC_VERSION=v0.16.0 curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh
```

Or override the install directory:

```bash
SFFMC_INSTALL_DIR=/opt/sffmc SFFMC_VERSION=v0.16.0 curl -fsSL ... | sh
```

## What `sffmc init` adds to opencode.json

The default (minimal) install adds three lines:

```jsonc
{
  "plugin": [
    "file:///home/you/.sffmc/plugins/sffmc/packages/safety/src/index.ts",
    "file:///home/you/.sffmc/plugins/sffmc/packages/memory/src/index.ts",
    "file:///home/you/.sffmc/plugins/sffmc/packages/runtime/src/index.ts",
    "file:///home/you/.sffmc/plugins/sffmc/packages/cognition/src/index.ts"
  ]
}
```

With `--all`, all 5 package paths are added. Existing non-SFFMC plugins
are left untouched.

## Troubleshooting

### "jq not found"

`sffmc init` requires `jq` to edit JSON safely.

```bash
# macOS
brew install jq

# Ubuntu / Debian
sudo apt install jq

# Arch
sudo pacman -S jq
```

**Fallback (Windows)**: `winget install jqlang.jq` or `choco install jq`.

### "No opencode.json found"

Create a minimal config first:

```bash
mkdir -p ~/.config/opencode
echo '{}' > ~/.config/opencode/opencode.json
```

Then re-run `sffmc init`.

### Permission errors on macOS/Linux

SFFMC installs to `~/.sffmc/plugins/sffmc` by default - no sudo needed.
If you see permission errors, check that `$HOME/.sffmc` is writable by
your user:

```bash
ls -ld ~/.sffmc ~/.sffmc/plugins
```

### Plugins don't activate after init

Restart OpenCode for changes to take effect. Verify with:

```bash
sffmc doctor
```

Or open any OpenCode chat session and call the `sffmc_health` tool -
if the tool appears in the tool list, the plugins loaded correctly.

## Uninstallation

```bash
sffmc uninstall    # remove file:// entries from opencode.json
rm -rf ~/.sffmc/plugins/sffmc   # delete the cloned repo
```

## Contributing (local dev)

If you're contributing to SFFMC, see [CONTRIBUTING.md](../CONTRIBUTING.md).
For local development, clone the repo manually and add `file://` entries
pointing at your working copy - this way your edits hot-reload without
re-running the installer.
