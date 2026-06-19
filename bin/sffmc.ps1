# sffmc.ps1 — SFFMC plugin CLI for Windows PowerShell
# Subcommands: init, update, uninstall, doctor, path, help
#
# Resolves SFFMC_DIR from the script's own location.
# Safe to run from anywhere; no admin required.

param(
    [Parameter(Position = 0)]
    [string]$Command,

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$Args
)

$ErrorActionPreference = "Stop"

# --- resolve SFFMC_DIR ------------------------------------------------
$ScriptPath = Split-Path $MyInvocation.MyCommand.Path -Parent
$SFFMC_DIR = Split-Path $ScriptPath -Parent

# --- helpers ----------------------------------------------------------
function Write-Info  { Write-Host "[sffmc] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[sffmc] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[sffmc] $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "[sffmc] $args" -ForegroundColor Red }

# --- usage ------------------------------------------------------------
function Show-Usage {
@"
Usage: sffmc <command> [options]

Commands:
  init [--minimal|--all|--only <pkg,...>|--yes]
                              Add SFFMC plugin paths to opencode.json.
                              --minimal (default): 3 composite packages
                              --all:            all 13 packages
                              --only p1,p2,...: specific packages
                              --yes:            skip confirmation prompt
  update                      git pull + re-init
  uninstall                   Remove all SFFMC entries from opencode.json
  doctor                      Run 13-check diagnostic
  path                        Print install directory
  help                        Show this help

Examples:
  sffmc init                  # Default: safety, memory, agentic
  sffmc init --all            # All 13 packages
  sffmc init --only workflow,compose,health  # Specific packages
  sffmc update                # Pull latest + re-sync config
  sffmc doctor                # Full diagnostic
  sffmc uninstall             # Remove all entries
"@
}

# --- detect opencode config path --------------------------------------
function Get-ConfigPath {
    $xdg = if ($env:XDG_CONFIG_HOME) { $env:XDG_CONFIG_HOME } else { Join-Path $HOME ".config" }
    $config = Join-Path $xdg "opencode\opencode.json"
    if (-not (Test-Path $config)) {
        $config = Join-Path $HOME ".config\opencode\opencode.json"
    }
    return $config
}

# --- list of all plugin directories -----------------------------------
$PLUGIN_DIRS = @(
    "packages\safety\src\index.ts",
    "packages\memory\src\index.ts",
    "packages\agentic\src\index.ts",
    "packages\watchdog\src\index.ts",
    "packages\rules\src\index.ts",
    "packages\auto-max\src\index.ts",
    "packages\eos-stripper\src\index.ts",
    "packages\log-whitelist\src\index.ts",
    "packages\extra\src\index.ts",
    "packages\max-mode\src\index.ts",
    "packages\workflow\src\index.ts",
    "packages\compose\src\index.ts",
    "packages\health\src\index.ts"
)

$PKG_MAP = @{
    "safety"        = 0;  "memory"        = 1;  "agentic"       = 2;
    "watchdog"      = 3;  "rules"         = 4;  "auto-max"      = 5;
    "eos-stripper"  = 6;  "log-whitelist" = 7;  "extra"         = 8;
    "max-mode"      = 9;  "workflow"      = 10; "compose"       = 11;
    "health"        = 12
}

function Resolve-Plugins {
    param([string]$Names)  # comma-separated
    $result = @()
    foreach ($name in ($Names -split ',' | ForEach-Object { $_.Trim() })) {
        if (-not $name) { continue }
        if ($PKG_MAP.ContainsKey($name)) {
            $idx = $PKG_MAP[$name]
            $result += "file:///$($SFFMC_DIR -replace '\\','/')/$($PLUGIN_DIRS[$idx] -replace '\\','/')"
        } else {
            Write-Warn "Unknown package: $name (skipping)"
        }
    }
    return $result
}

# --- init subcommand --------------------------------------------------
function Invoke-Init {
    $mode = "minimal"
    $yes  = $false
    $only = $null
    $rest = @()

    for ($i = 0; $i -lt $Args.Count; $i++) {
        switch ($Args[$i]) {
            "--minimal" { $mode = "minimal" }
            "--all"     { $mode = "all" }
            "--only"    { $mode = "only"; if (++$i -lt $Args.Count) { $only = $Args[$i] } else { Write-Err "--only requires a comma-separated list"; exit 2 } }
            "--yes"     { $yes = $true }
            "-h"        { Show-Usage; exit 0 }
            "--help"    { Show-Usage; exit 0 }
            default     { Write-Err "Unknown option: $($Args[$i])"; Show-Usage; exit 2 }
        }
    }

    if ($env:SFFMC_AUTO_YES -eq "1" -or $env:SFFMC_AUTO_YES -eq "true") {
        $yes = $true
    }

    # Check for jq
    if (!(Get-Command jq -ErrorAction SilentlyContinue)) {
        Write-Err "jq is required for opencode.json editing."
        Write-Err "  Install via: winget install jqlang.jq  or  choco install jq"
        Write-Err "  Or add to PATH from: https://jqlang.github.io/jq/download/"
        exit 2
    }

    $config = Get-ConfigPath
    if (!(Test-Path $config)) {
        Write-Err "No opencode.json found at: $config"
        Write-Err "Create one first (e.g. echo '{}' > config) and run sffmc init again."
        exit 2
    }

    # Determine plugin paths to add
    $wanted = @()
    switch ($mode) {
        "minimal" {
            $wanted = Resolve-Plugins "safety,memory,agentic"
            Write-Info "Minimal install: adding 3 composite packages (safety, memory, agentic)"
        }
        "all" {
            $wanted = Resolve-Plugins "safety,memory,agentic,watchdog,rules,auto-max,eos-stripper,log-whitelist,extra,max-mode,workflow,compose,health"
            Write-Info "Full install: adding all 13 packages"
        }
        "only" {
            $wanted = Resolve-Plugins $only
            Write-Info "Selective install: adding requested packages"
        }
    }

    if ($wanted.Count -eq 0) {
        Write-Err "No valid packages to add."
        exit 2
    }

    Write-Host ""
    foreach ($p in $wanted) { Write-Host "  + $p" }
    Write-Host ""

    if (-not $yes) {
        $answer = Read-Host "[sffmc] Add these to $config? [Y/n]"
        if ($answer -eq "n" -or $answer -eq "N") {
            Write-Info "Aborted."
            exit 0
        }
    }

    # Backup
    $backup = "$config.bak-sffmc-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $config $backup
    Write-Ok "Backed up config to $(Split-Path $backup -Leaf)"

    # Read current JSON
    $content = Get-Content $config -Raw | ConvertFrom-Json

    # Ensure plugin array exists
    if (-not $content.PSObject.Properties["plugin"]) {
        Write-Info 'Adding "plugin" array to config...'
        $content | Add-Member -MemberType NoteProperty -Name "plugin" -Value @()
    }

    $current = $content.plugin
    $added = 0
    $skipped = 0
    $toAdd = @()

    foreach ($p in $wanted) {
        if ($current -contains $p) {
            Write-Info "Already present: $p (skipping)"
            $skipped++
        } else {
            $toAdd += $p
        }
    }

    if ($toAdd.Count -eq 0) {
        Write-Ok "All requested plugins already in config. Nothing to do."
        exit 0
    }

    $newPlugin = $current + $toAdd
    $added = $toAdd.Count

    # Use jq to write back (preserve JSON formatting)
    $newPluginJson = $newPlugin | ConvertTo-Json -Compress
    $tmpFile = "$config.tmp"
    & jq --argjson plugins "$newPluginJson" '.plugin = $plugins' "$config" > $tmpFile
    Move-Item -Force $tmpFile $config

    Write-Ok "Added $added new plugin(s) to $config"
    if ($skipped -gt 0) { Write-Info "Skipped $skipped already-present plugin(s)" }
    Write-Host ""
    Write-Info "Restart OpenCode for changes to take effect."
    Write-Info "Verify with: sffmc doctor"
}

# --- update subcommand ------------------------------------------------
function Invoke-Update {
    Write-Info "Updating SFFMC from git..."
    Push-Location $SFFMC_DIR
    try {
        git fetch origin --tags 2>&1 | ForEach-Object { Write-Host "  $_" }
        git pull --ff-only 2>&1 | ForEach-Object { Write-Host "  $_" }
        $head = (git rev-parse --short HEAD 2>$null) -replace "`n|`r", ""
        Write-Ok "Updated to $head"
    } finally {
        Pop-Location
    }
    Write-Host ""
    Write-Info "Re-syncing opencode.json..."
    Invoke-Init @Args
}

# --- uninstall subcommand ---------------------------------------------
function Invoke-Uninstall {
    $config = Get-ConfigPath
    if (!(Test-Path $config)) {
        Write-Err "No opencode.json found at: $config"
        exit 2
    }

    if (!(Get-Command jq -ErrorAction SilentlyContinue)) {
        Write-Err "jq is required."
        exit 2
    }

    $prefix = "file:///$($SFFMC_DIR -replace '\\','/')/"
    $count = 0
    $content = Get-Content $config -Raw | ConvertFrom-Json
    if ($content.PSObject.Properties["plugin"]) {
        foreach ($p in $content.plugin) {
            if ($p.StartsWith($prefix)) { $count++ }
        }
    }

    if ($count -eq 0) {
        Write-Info "No SFFMC entries found in config. Nothing to uninstall."
        exit 0
    }

    Write-Info "Found $count SFFMC plugin(s) in $config"
    $answer = Read-Host "[sffmc] Remove them? [y/N]"
    if ($answer -ne "y" -and $answer -ne "Y") {
        Write-Info "Aborted."
        exit 0
    }

    $backup = "$config.bak-sffmc-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item $config $backup
    Write-Ok "Backed up to $(Split-Path $backup -Leaf)"

    $tmpFile = "$config.tmp"
    & jq --arg dir "$prefix" '.plugin = [.plugin[]? | select(startswith($dir) | not)]' "$config" > $tmpFile
    Move-Item -Force $tmpFile $config

    Write-Ok "Removed $count SFFMC plugin(s) from $config"
    Write-Info "Restart OpenCode for changes to take effect."
}

# --- doctor subcommand ------------------------------------------------
function Invoke-Doctor {
    $healthScript = Join-Path $SFFMC_DIR "scripts\run-health.ts"
    if (!(Test-Path $healthScript)) {
        Write-Err "Health script not found: $healthScript"
        exit 2
    }

    if (!(Get-Command bun -ErrorAction SilentlyContinue)) {
        Write-Err "bun is required to run the doctor diagnostic. Install: https://bun.sh"
        exit 2
    }

    Write-Info "Running 13-check diagnostic..."
    Push-Location $SFFMC_DIR
    try {
        bun run $healthScript
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    } finally {
        Pop-Location
    }
}

# --- path subcommand --------------------------------------------------
function Invoke-Path {
    Write-Host $SFFMC_DIR
}

# --- dispatch ---------------------------------------------------------
if (-not $Command) {
    Show-Usage
    exit 0
}

switch ($Command) {
    "init"       { Invoke-Init @Args; break }
    "update"     { Invoke-Update @Args; break }
    "uninstall"  { Invoke-Uninstall @Args; break }
    "doctor"     { Invoke-Doctor @Args; break }
    "path"       { Invoke-Path; break }
    "help"       { Show-Usage; break }
    "--help"     { Show-Usage; break }
    "-h"         { Show-Usage; break }
    default      { Write-Err "Unknown command: $Command"; Show-Usage; exit 2 }
}
