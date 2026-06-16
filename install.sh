#!/usr/bin/env bash
# SFFMC — one-liner install for Linux / macOS
# Usage: curl -fsSL https://raw.githubusercontent.com/Rahspide/sffmc/main/install.sh | sh
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
REPO_URL="https://github.com/Rahspide/sffmc.git"

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

# --- install ------------------------------------------------------
if [ -d "${SFFMC_INSTALL_DIR}/.git" ]; then
  info "Repo exists; updating via git pull --ff-only..."
  cd "${SFFMC_INSTALL_DIR}"
  git fetch origin --tags 2>&1 | sed 's/^/  /' || warn "git fetch had non-zero exit (may be benign)"
  git checkout "${SFFMC_VERSION}" 2>&1 | sed 's/^/  /'
  git pull --ff-only origin "${SFFMC_VERSION}" 2>&1 | sed 's/^/  /'
  ok "Updated to $(git rev-parse --short HEAD)"
else
  info "Cloning repo (branch=${SFFMC_VERSION}, depth=1)..."
  mkdir -p "$(dirname "${SFFMC_INSTALL_DIR}")"
  git clone --branch "${SFFMC_VERSION}" --depth 1 "${REPO_URL}" "${SFFMC_INSTALL_DIR}" 2>&1 | sed 's/^/  /'
  cd "${SFFMC_INSTALL_DIR}"
  ok "Cloned to $(git rev-parse --short HEAD)"
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
