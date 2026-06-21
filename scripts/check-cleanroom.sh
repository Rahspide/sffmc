#!/usr/bin/env bash
# SFFMC cleanroom gate — verify no external deps, plugin refs, or workflow leaks.
# Exit 0 on pass, 1 on fail. Run via `bun run check:cleanroom`.
#
# SELF-EXCLUSION: this file is a string-matching gate. It contains the patterns
# it greps for. Always exclude itself from scans via the SELF filter below.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Self-exclusion filter — pipes through it
SELF="scripts/check-cleanroom.sh"
EXCLUDE_SELF() { grep -v "$SELF"; }

FAIL=0
log() { echo "[cleanroom] $*"; }
err() { echo "[cleanroom][FAIL] $*" >&2; FAIL=1; }

# --- 1. External URLs (allow only github.com/Rahspide/sffmc, localhost, 127.0.0.1) ---
log "1/4 external URLs..."
EXTERNAL_URLS=$(grep -rPn --include="*.ts" --include="*.js" --include="*.json" --include="*.sh" --include="*.yml" --include="*.yaml" \
  'https?://(?![Pp]?(github\.com/Rahspide/sffmc|github\.com/davisjam/safe-regex|localhost|127\.0\.0\.1|registry\.npmjs\.org|img\.shields\.io|bun\.sh)\b)' \
  packages/ shared/ bin/ scripts/ .drone.yml *.md 2>/dev/null \
  | grep -v "node_modules" \
  | grep -vE "/(test|spec)/" \
  | grep -v "\.slim/" \
  | grep -v "/codemap\.md:" \
  | EXCLUDE_SELF || true)
if [ -n "$EXTERNAL_URLS" ]; then
  err "external URLs found (only github.com/Rahspide/sffmc and localhost allowed):"
  echo "$EXTERNAL_URLS" | head -10 >&2
fi

# --- 2. Internal paths/hosts ---
log "2/4 internal paths/hosts..."
INTERNAL=$(grep -rEn --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" \
  -e "/data/projects" -e "/home/opencode" -e "nipogi" -e "maggot" -e "tailscale" \
  -e "192\.168\.[0-9]+" -e "100\.[0-9]+\.[0-9]+\.[0-9]+" \
  packages/ shared/ bin/ scripts/ docs/ *.md 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "scripts/audit-public-content.sh" \
  | grep -v "\.slim/" \
  | grep -v "/codemap\.md:" \
  | EXCLUDE_SELF || true)
if [ -n "$INTERNAL" ]; then
  err "internal paths/hosts found:"
  echo "$INTERNAL" | head -10 >&2
fi

# --- 3. Workflow terms and internal labels (allowlist: compose skills/README only) ---
log "3/4 workflow terms and internal labels..."
WORKFLOW_FOUND=0
# Patterns to ban (word-boundary). Excludes compose skills (real skill name "subagent").
# L1, L2, H*, C*, D*, X* removed — too many false positives. Manual review if needed.
for pattern in \
  "reconnaissance" "MVP" "code-name" \
  "W19" "W22" "W21" "W23" "W24" "W17a" "W17b" "W17c" \
  "M1\b" "M2\b" "M3\b" "M4\b" "M5\b" "M6\b" "M7\b" "M8\b" "M9\b" "M10\b" "M11\b" \
  "M5a\b" "M5b\b" \
  "E1\b" "E2\b" "E3\b" "E4\b" "E5\b" "E6\b" "E7\b" "E8\b" "E9\b" "E10\b" "E12\b" "E13\b" \
  "C1\b" "C2\b" "C3\b" \
  "H5\b" "H6\b" "H7\b" \
  "X1\b" "X2\b" "X3\b"; do
  HITS=$(grep -rEn "\b${pattern}" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" \
    packages/ shared/ bin/ scripts/ docs/ *.md 2>/dev/null \
    | grep -v "node_modules" \
    | grep -v "packages/compose/skills/" \
    | grep -v "packages/compose/README.md" \
    | grep -v "packages/compose/codemap.md" \
    | grep -v "\.slim/" \
    | grep -v "/codemap\.md:" \
    | EXCLUDE_SELF || true)
  if [ -n "$HITS" ]; then
    err "found pattern '${pattern}':"
    echo "$HITS" | head -3 >&2
    WORKFLOW_FOUND=1
  fi
done

# Phase X, Phase-X
PHASE_HITS=$(grep -rEn "Phase[- ][12345]" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" \
  packages/ shared/ bin/ scripts/ docs/ *.md 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "packages/compose/skills/" \
  | grep -v "packages/compose/README.md" \
  | grep -v "packages/compose/codemap.md" \
  | grep -v "\.slim/" \
  | grep -v "/codemap\.md:" \
  | EXCLUDE_SELF || true)
if [ -n "$PHASE_HITS" ]; then
  err "found 'Phase N' references outside compose skills:"
  echo "$PHASE_HITS" | head -5 >&2
  WORKFLOW_FOUND=1
fi

# "subagent" outside compose (real skill name exception — compose, agentic, docs)
SUBAGENT_HITS=$(grep -rEn "subagent" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" \
  packages/ shared/ bin/ scripts/ docs/ *.md 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "packages/compose/" \
  | grep -v "packages/agentic/" \
  | grep -v "^docs/" \
  | grep -v "\.slim/" \
  | grep -v "/codemap\.md:" \
  | EXCLUDE_SELF || true)
if [ -n "$SUBAGENT_HITS" ]; then
  err "found 'subagent' outside compose skills (real skill name exception):"
  echo "$SUBAGENT_HITS" | head -3 >&2
  WORKFLOW_FOUND=1
fi

# "roadmap" in non-compose files
ROADMAP_HITS=$(grep -rEn "roadmap" --include="*.ts" --include="*.js" --include="*.json" --include="*.md" --include="*.sh" --include="*.yml" --include="*.yaml" \
  packages/ shared/ bin/ scripts/ docs/ *.md 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "packages/compose/" \
  | grep -v "\.slim/" \
  | grep -v "/codemap\.md:" \
  | EXCLUDE_SELF || true)
if [ -n "$ROADMAP_HITS" ]; then
  err "found 'roadmap' (use 'future work' or 'next steps'):"
  echo "$ROADMAP_HITS" | head -3 >&2
  WORKFLOW_FOUND=1
fi

# --- 4. External plugin/gateway references ---
log "4/4 external plugin/gateway references..."
PLUGIN_HITS=$(grep -rEn --include="*.ts" --include="*.js" --include="*.json" \
  -e "9router" -e "icm-hybrid" -e "icm-bridge" -e "@icm/" -e "@mcp/" -e "opencode-root" -e "@tarquinen/opencode-dcp" \
  packages/ shared/ bin/ scripts/ 2>/dev/null \
  | grep -v "node_modules" \
  | grep -vE "/(test|spec)/" \
  | EXCLUDE_SELF || true)
if [ -n "$PLUGIN_HITS" ]; then
  err "external plugin/gateway references found:"
  echo "$PLUGIN_HITS" | head -5 >&2
fi

# --- Summary ---
if [ $FAIL -eq 0 ]; then
  log "✓ cleanroom check passed"
  exit 0
else
  err "✗ cleanroom check failed"
  exit 1
fi
