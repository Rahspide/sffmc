#!/usr/bin/env bash
set -euo pipefail

# scripts/release.sh — publish SFFMC monorepo packages to npm
#
# Usage:
#   ./scripts/release.sh               # dry-run (default)
#   ./scripts/release.sh --actual      # actually publish
#   ./scripts/release.sh --only=safety # publish only one package
#   ./scripts/release.sh --help        # show help

# -- defaults ----------------------------------------------------------
DRY_RUN=true
ONLY=""      # if set, only publish this package (e.g. "shared" or "safety")
VERBOSE=false

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# -- help --------------------------------------------------------------
show_help() {
  cat <<EOF
release.sh — publish SFFMC monorepo packages to npm (via bun publish)

Usage: $0 [flags]

Flags:
  --actual            Actually publish (default is dry-run)
  --dry-run           Dry-run only (default; explicit form)
  --only=<pkg>        Publish only <pkg> (e.g. "shared" or "safety")
  -v, --verbose       Verbose output
  -h, --help          Show this help

Publish order: shared/ first, then packages/ alphabetically.

Precondition checks (fail-fast before any publish):
  1. Version consistency: root and all packages/* at the same version
  2. Working tree clean (git status --porcelain)
  3. npm login (npm whoami)
  4. npm org sffmc exists (npm org ls sffmc)
  5. git tag v0.9.0 exists (warns if missing)

Exit codes:
  0  success
  1  publish failure
  2  precondition unmet
EOF
}

# -- parse args --------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --actual)   DRY_RUN=false; shift ;;
    --dry-run)  DRY_RUN=true; shift ;;
    --only=*)   ONLY="${1#*=}"; shift ;;
    -v|--verbose) VERBOSE=true; shift ;;
    -h|--help)  show_help; exit 0 ;;
    *)          echo "[ERROR] Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# -- colors ------------------------------------------------------------
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[1;33m'
  NC='\033[0m'  # No Color
else
  GREEN=''; RED=''; YELLOW=''; NC=''
fi

# -- log helpers -------------------------------------------------------
info()  { echo -e "[INFO]  $*"; }
warn()  { echo -e "[WARN]  ${YELLOW}$*${NC}" >&2; }
error() { echo -e "[ERROR] ${RED}$*${NC}" >&2; }
ok()    { echo -e "${GREEN}OK${NC}"; }

# -- precondition checks -----------------------------------------------
check_version_consistency() {
  info "Checking version consistency (root + packages/*)..."
  local root_version
  root_version=$(jq -r .version package.json)
  local pkg_versions
  pkg_versions=$(jq -r .version packages/*/package.json | sort -u)
  local pkg_versions_csv
  pkg_versions_csv=$(echo "$pkg_versions" | paste -sd, -)

  # v0.14.3: dynamic comparison — root must match the single unique package version.
  # Previously hardcoded to "0.12.0" which broke every release since v0.12.0.
  if [[ "$(echo "$pkg_versions" | wc -l)" -gt 1 ]] || [[ "$root_version" != "$(echo "$pkg_versions" | head -1)" ]]; then
    error "version mismatch: root=$root_version, packages=$pkg_versions_csv"
    error "All packages and root package.json must be at the same version."
    exit 2
  fi
  echo -e "  ${GREEN}root and packages all at $root_version${NC}"
}

check_git_clean() {
  info "Checking git working tree is clean..."
  if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
    error "Working tree is NOT clean. Commit or stash changes first."
    git -C "$REPO_ROOT" status --short
    exit 2
  fi
  echo -e "  ${GREEN}git working tree clean${NC}"
}

check_npm_login() {
  info "Checking npm login status..."
  local user
  if user=$(npm whoami 2>/dev/null); then
    echo -e "  ${GREEN}logged in as: $user${NC}"
  else
    error "Not logged into npm."
    error "Run: npm login"
    exit 2
  fi
}

check_npm_org() {
  info "Checking npm org 'sffmc' exists..."
  if npm org ls sffmc >/dev/null 2>&1; then
    echo -e "  ${GREEN}org 'sffmc' exists${NC}"
  else
    error "npm org 'sffmc' not found."
    error "Run: npm org create sffmc"
    exit 2
  fi
}

check_tag() {
  info "Checking git tag v0.9.0 exists..."
  if git -C "$REPO_ROOT" rev-parse "v0.9.0" >/dev/null 2>&1; then
    echo -e "  ${GREEN}tag v0.9.0 exists${NC}"
  else
    warn "git tag v0.9.0 not found. Publishing without tag gate."
  fi
}

check_bun() {
  if ! command -v bun &>/dev/null; then
    error "bun not found in PATH."
    exit 2
  fi
}

# -- plan --------------------------------------------------------------
plan_publishes() {
  echo ""
  echo "Publish plan:"
  echo "  1. shared/ (@sffmc/shared)"
  local i=2
  for p in "$REPO_ROOT"/packages/*/; do
    local pkg_name
    pkg_name=$(basename "$p")
    local pkg_full
    pkg_full=$(jq -r .name "$p/package.json" 2>/dev/null || echo "?")
    echo "  $i. packages/${pkg_name}/ (${pkg_full})"
    ((i++))
  done
  echo ""

  if $DRY_RUN; then
    info "Mode: ${YELLOW}DRY-RUN${NC} (no actual publishes)"
  else
    warn "Mode: ACTUAL publish (packages will be published to npm)"
  fi
  echo ""
}

# -- publish one package -----------------------------------------------
run_publish() {
  local pkg_dir="$1"
  local pkg_name
  pkg_name=$(jq -r .name "$pkg_dir/package.json")
  local pkg_version
  pkg_version=$(jq -r .version "$pkg_dir/package.json")

  if $DRY_RUN; then
    info "DRY-RUN: ${pkg_name}@${pkg_version} (in ${pkg_dir#$REPO_ROOT/})"
    if (cd "$pkg_dir" && bun publish --dry-run); then
      echo -e "  ${GREEN}dry-run OK${NC}"
    else
      error "dry-run FAILED for ${pkg_name}"
      return 1
    fi
  else
    info "PUBLISH: ${pkg_name}@${pkg_version} (in ${pkg_dir#$REPO_ROOT/})"
    if (cd "$pkg_dir" && bun publish --access public --tolerate-republish); then
      echo -e "  ${GREEN}published OK${NC}"
    else
      error "publish FAILED for ${pkg_name}"
      return 1
    fi
  fi
}

# -- main --------------------------------------------------------------
main() {
  # Schema check: CD to repo root now so relative paths are consistent
  cd "$REPO_ROOT"

  echo ""
  echo "=== SFFMC release.sh ==="
  echo ""

  # -- precondition checks (fail-fast) --
  check_version_consistency
  check_bun
  check_git_clean
  check_npm_login
  check_npm_org
  check_tag
  echo ""

  # -- show plan --
  plan_publishes

  # -- confirm if actual --
  if ! $DRY_RUN; then
    warn "About to ACTUALLY publish. Press Ctrl-C in 5 seconds to abort..."
    sleep 5
    echo ""
  fi

  # -- publish: shared first --
  local errors=0

  if [[ -z "$ONLY" || "$ONLY" == "shared" ]]; then
    if [[ -f "$REPO_ROOT/shared/package.json" ]]; then
      run_publish "$REPO_ROOT/shared" || ((errors++))
    else
      warn "shared/package.json not found — skipping"
    fi
  fi

  # -- publish: packages alphabetically --
  for p in "$REPO_ROOT"/packages/*/; do
    local pkg_base
    pkg_base=$(basename "$p")
    if [[ -z "$ONLY" || "$ONLY" == "$pkg_base" ]]; then
      if [[ -f "$p/package.json" ]]; then
        run_publish "$p" || ((errors++))
      else
        warn "packages/${pkg_base}/package.json not found — skipping"
      fi
    fi
  done

  # -- summary --
  echo ""
  if [[ $errors -eq 0 ]]; then
    echo -e "[INFO]  ${GREEN}All publishes complete.${NC}"
    exit 0
  else
    error "${errors} package(s) failed to publish."
    exit 1
  fi
}

main "$@"
