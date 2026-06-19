#!/usr/bin/env bash
# SFFMC — one-liner install for Linux / macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh
#        (requires SSH key on GitHub OR SFFMC_GITHUB_TOKEN env var for non-interactive runs)
#
# Defaults (override via env vars):
#   SFFMC_INSTALL_DIR  → ~/.sffmc/plugins/sffmc
#   SFFMC_VERSION      → main
#   SFFMC_AUTO_YES     → (if set, skip init confirmation prompt)
#
# After clone/pull, runs `sffmc init --yes`.

set -euo pipefail

# --- color helpers ------------------------------------------------
if [ -t 1 ] && command -v tput >/dev/null 2>&1; then
  RED=$(tput setaf 1)
  GREEN=$(tput setaf 2)
  YELLOW=$(tput setaf 3)
  CYAN=$(tput setaf 6)
  BOLD=$(tput bold)
  RESET=$(tput sgr0)
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()  { echo "${CYAN}[SFFMC]${RESET} $*"; }
ok()    { echo "${GREEN}[SFFMC]${RESET} $*"; }
warn()  { echo "${YELLOW}[SFFMC]${RESET} $*"; }
err()   { echo "${RED}[SFFMC]${RESET} $*" >&2; }

# --- resolve install dir ------------------------------------------
SFFMC_INSTALL_DIR="${SFFMC_INSTALL_DIR:-$HOME/.sffmc/plugins/sffmc}"
SFFMC_VERSION="${SFFMC_VERSION:-main}"
REPO_URL="git@github.com:Rahspide/sffmc.git"

info "Install dir : ${SFFMC_INSTALL_DIR}"
info "Version     : ${SFFMC_VERSION}"

# --- preflight: git -----------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  err "git is required but not installed. Install it first:"
  err "  macOS:   xcode-select --install"
  err "  Ubuntu:  sudo apt install git"
  err "  Arch:    sudo pacman -S git"
  exit 1
fi
git_ver=$(git --version 2>/dev/null || true)
info "Git         : ${git_ver}"

# --- preflight: non-interactive auth -------------------------------
if [ ! -t 0 ] && [ -z "${SFFMC_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}" ] && ! command -v ssh >/dev/null 2>&1; then
  err "Running non-interactively (curl | sh). You need either:"
  err "  1. SSH key set up with GitHub (https://docs.github.com/en/authentication/connecting-to-github-with-ssh)"
  err "  2. GITHUB_TOKEN set: curl -fsSL ... | SFFMC_GITHUB_TOKEN=<your-token> sh"
  exit 1
fi

# --- install ------------------------------------------------------
if [ -d "${SFFMC_INSTALL_DIR}/.git" ]; then
  info "Repo exists; updating via git pull --ff-only..."
  cd "${SFFMC_INSTALL_DIR}"
  git fetch origin --tags 2>&1 | sed 's/^/  /' || warn "git fetch had non-zero exit (may be benign)"
  git checkout "${SFFMC_VERSION}" 2>&1 | sed 's/^/  /'
  git pull --ff-only origin "${SFFMC_VERSION}" 2>&1 | sed 's/^/  /'
  ok "Updated to $(git rev-parse --short HEAD)"

  # Integrity: verify GPG signature if gpg is available
  if command -v gpg >/dev/null 2>&1; then
    if git verify-commit HEAD 2>/dev/null; then
      ok "GPG signature verified"
    else
      if [ "${SFFMC_STRICT_GPG:-}" = "1" ]; then
        err "GPG signature verification failed — aborting (SFFMC_STRICT_GPG=1)"
        exit 1
      fi
      warn "GPG signature verification failed or no signed commits — continue at your own risk"
    fi
  fi
else
  info "Cloning repo (branch=${SFFMC_VERSION}, depth=1)..."
  mkdir -p "$(dirname "${SFFMC_INSTALL_DIR}")"

  # Try SSH first (REPO_URL), fall back to HTTPS+token on failure
  clone_ok=0
  git clone --branch "${SFFMC_VERSION}" --depth 1 "${REPO_URL}" "${SFFMC_INSTALL_DIR}" 2>&1 | sed 's/^/  /' && clone_ok=1 || true

  if [ $clone_ok -eq 0 ]; then
    _sffmc_token="${SFFMC_GITHUB_TOKEN:-${GITHUB_TOKEN:-}}"
    if [ -n "${_sffmc_token}" ]; then
      warn "SSH failed; retrying with HTTPS+token..."
      git -c "http.extraHeader=Authorization: token ${_sffmc_token}" clone --branch "${SFFMC_VERSION}" --depth 1 "https://github.com/Rahspide/sffmc.git" "${SFFMC_INSTALL_DIR}" 2>&1 | sed 's/^/  /'
    else
      err "SSH authentication failed and no SFFMC_GITHUB_TOKEN / GITHUB_TOKEN set."
      err "  Set up SSH: https://docs.github.com/en/authentication/connecting-to-github-with-ssh"
      err "  Or set token: export SFFMC_GITHUB_TOKEN=<your-token>"
      exit 1
    fi
  fi

  cd "${SFFMC_INSTALL_DIR}"
  ok "Cloned to $(git rev-parse --short HEAD)"

  # Integrity: verify GPG signature if gpg is available
  if command -v gpg >/dev/null 2>&1; then
    if git verify-commit HEAD 2>/dev/null; then
      ok "GPG signature verified"
    else
      if [ "${SFFMC_STRICT_GPG:-}" = "1" ]; then
        err "GPG signature verification failed — aborting (SFFMC_STRICT_GPG=1)"
        exit 1
      fi
      warn "GPG signature verification failed or no signed commits — continue at your own risk"
    fi
  else
    if [ "${SFFMC_STRICT_GPG:-}" = "1" ]; then
      err "gpg not found — cannot verify commit signatures (SFFMC_STRICT_GPG=1)"
      exit 1
    fi
    warn "gpg not found — skipping commit signature verification"
  fi
fi

# --- preflight: dependencies --------------------------------------
# SFFMC requires bun (for runtime) and jq (for init JSON editing)
MISSING_DEPS=()
if ! command -v bun >/dev/null 2>&1; then
  MISSING_DEPS+=("bun")
fi
if ! command -v jq >/dev/null 2>&1; then
  MISSING_DEPS+=("jq")
fi
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
  warn "Missing recommended dependencies: ${MISSING_DEPS[*]}"
  warn "  bun: OpenCode plugin runtime — https://bun.sh"
  warn "  jq:  JSON editor for opencode.json — install via your package manager"
  warn "Install them before running 'sffmc init' (auto-detect will warn again)."
fi

# --- init ---------------------------------------------------------
CLI="${SFFMC_INSTALL_DIR}/bin/sffmc"
if [ -x "${CLI}" ]; then
  if [ -n "${SFFMC_AUTO_YES:-}" ]; then
    info "Running sffmc init --yes..."
    "${CLI}" init --yes
  else
    info "Running sffmc init..."
    "${CLI}" init
  fi
else
  warn "Cannot run sffmc init (${CLI} not found or not executable)."
  warn "Add the plugins manually to ~/.config/opencode/opencode.json."
fi

# --- done ---------------------------------------------------------
echo ""
ok "SFFMC installed successfully!"
echo ""
echo "  ${BOLD}Next steps:${RESET}"
echo "  1. Restart OpenCode after init"
echo "  2. Verify with: ${CYAN}sffmc doctor${RESET}"
echo "     or:        ${CYAN}${CLI} doctor${RESET}"
echo "     or type   ${CYAN}sffmc_health${RESET} in any OpenCode chat"
echo ""
echo "  ${BOLD}CLI reference:${RESET}"
echo "    sffmc init          re-sync opencode.json"
echo "    sffmc init --all    install all 13 packages"
echo "    sffmc update        git pull + re-init"
echo "    sffmc doctor        run 13-check diagnostic"
echo "    sffmc uninstall     remove all SFFMC entries from config"
echo ""
