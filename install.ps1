# SFFMC — one-liner install for Windows PowerShell
# Usage: irm https://raw.githubusercontent.com/Rahspide/sffmc/main/install.ps1 | iex
#
# Defaults (override via env vars):
#   $env:SFFMC_INSTALL_DIR → $HOME\.sffmc\plugins\sffmc
#   $env:SFFMC_VERSION     → main
#   $env:SFFMC_AUTO_YES    → (if set, skip init confirmation prompt)
#
# After clone/pull, runs `bin/sffmc init --yes`.

$ErrorActionPreference = "Stop"

# --- helpers --------------------------------------------------------
function Write-Info  { Write-Host "[SFFMC] $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "[SFFMC] $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "[SFFMC] $args" -ForegroundColor Yellow }
function Write-Err   { Write-Host "[SFFMC] $args" -ForegroundColor Red }

# --- resolve install dir --------------------------------------------
$SFFMC_INSTALL_DIR = if ($env:SFFMC_INSTALL_DIR) { $env:SFFMC_INSTALL_DIR } else { Join-Path $HOME ".sffmc\plugins\sffmc" }
$SFFMC_VERSION = if ($env:SFFMC_VERSION) { $env:SFFMC_VERSION } else { "main" }
$REPO_URL = "https://github.com/Rahspide/sffmc.git"

Write-Info "Install dir : $SFFMC_INSTALL_DIR"
Write-Info "Version     : $SFFMC_VERSION"

# --- preflight: git -------------------------------------------------
if (!(Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err "git is required but not installed."
    Write-Err "  Install from: https://git-scm.com/download/win"
    Write-Err "  Or via: winget install --id Git.Git"
    exit 1
}
$gitVer = (git --version 2>$null) -replace "`n|`r"
Write-Info "Git         : $gitVer"

# --- install --------------------------------------------------------
if (Test-Path (Join-Path $SFFMC_INSTALL_DIR ".git")) {
    Write-Info "Repo exists; updating via git pull --ff-only..."
    Push-Location $SFFMC_INSTALL_DIR
    try {
        git fetch origin --tags 2>&1 | ForEach-Object { Write-Host "  $_" }
        git checkout $SFFMC_VERSION 2>&1 | ForEach-Object { Write-Host "  $_" }
        git pull --ff-only origin $SFFMC_VERSION 2>&1 | ForEach-Object { Write-Host "  $_" }
        $head = (git rev-parse --short HEAD 2>$null) -replace "`n|`r", ""
        Write-Ok "Updated to $head"
    } finally {
        Pop-Location
    }
} else {
    Write-Info "Cloning repo (branch=$SFFMC_VERSION, depth=1)..."
    $parent = Split-Path $SFFMC_INSTALL_DIR -Parent
    New-Item -ItemType Directory -Force -Path $parent | Out-Null
    git clone --branch $SFFMC_VERSION --depth 1 $REPO_URL $SFFMC_INSTALL_DIR 2>&1 | ForEach-Object { Write-Host "  $_" }
    Push-Location $SFFMC_INSTALL_DIR
    try {
        $head = (git rev-parse --short HEAD 2>$null) -replace "`n|`r", ""
        Write-Ok "Cloned to $head"
    } finally {
        Pop-Location
    }
}

# --- preflight: dependencies ----------------------------------------
$missingDeps = @()
if (!(Get-Command bun -ErrorAction SilentlyContinue)) {
    $missingDeps += "bun"
}
if (!(Get-Command jq -ErrorAction SilentlyContinue)) {
    $missingDeps += "jq"
}
if ($missingDeps.Count -gt 0) {
    Write-Warn "Missing recommended dependencies: $($missingDeps -join ', ')"
    Write-Warn "  bun: OpenCode plugin runtime — https://bun.sh"
    Write-Warn "  jq:  JSON editor for opencode.json — install via winget or choco"
    Write-Warn "Install them before running 'sffmc init'."
}

# --- init -----------------------------------------------------------
$CLI = Join-Path $SFFMC_INSTALL_DIR "bin\sffmc.bat"
if (-not (Test-Path $CLI)) {
    # Fall back to calling the bash script via git-bash or WSL
    $CLI = Join-Path $SFFMC_INSTALL_DIR "bin\sffmc"
}
if (Test-Path $CLI) {
    if ($env:SFFMC_AUTO_YES) {
        Write-Info "Running sffmc init --yes..."
        & $CLI init --yes
    } else {
        Write-Info "Running sffmc init..."
        & $CLI init
    }
} else {
    Write-Warn "Cannot run sffmc init (CLI not found at $CLI)."
    Write-Warn "Add the plugins manually to ~\.config\opencode\opencode.json."
}

# --- done -----------------------------------------------------------
Write-Host ""
Write-Ok "SFFMC installed successfully!"
Write-Host ""
Write-Host "  Next steps:"
Write-Host "  1. Restart OpenCode after init"
Write-Host "  2. Verify with: sffmc doctor  or  $CLI doctor"
Write-Host "     or type sffmc_health in any OpenCode chat"
Write-Host ""

exit 0
