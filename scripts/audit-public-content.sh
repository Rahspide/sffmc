#!/usr/bin/env bash
# scripts/audit-public-content.sh
#
# Greps the public repo surface for terms that must not appear in user-facing
# docs. Catches accidental leaks of internal infrastructure, AI-gateway
# specifics, SFFMC-internal agent names, and Anthropic model names (SFFMC
# ships without Anthropic dependencies).
#
# Scope: only .md files in repo root and docs/ (NOT README.md unless explicitly
# required, NOT LICENSE, NOT CHANGELOG.md which may legitimately mention
# historical internals).
#
# Exit code: 0 = clean, 1 = at least one leak.
#
# Wire this into:
#   - package.json "scripts": "audit:public": "bash scripts/audit-public-content.sh"
#   - .drone.yml publish step (so it runs before any tag push)
#   - .git/hooks/pre-commit (manual install by contributors)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files in scope. CHANGELOG.md is excluded because it is a historical record
# and may legitimately reference models or 9Router terms from past versions.
SCOPE=(
  README.md
  CONTRIBUTING.md
  docs/
  packages/*/README.md
  packages/*/config/*.example.yaml
  packages/*/skills/*.md
  scripts/*.py
  packages/*/src/*.ts
  shared/src/*.ts
)

# Files excluded from the public audit (maintainer-internal docs that
# legitimately reference upstream OpenCode internals, plugin wrappers, or
# historical scaffold).
#   - docs/load-order-audit.md : hook registration audit, names external
#     OpenCode wrappers it observes (e.g. oh-my-opencode-slim) — accurate
#     signal for SFFMC maintainers, not for end users.
EXCLUDE_FILES=(
  docs/load-order-audit.md
)

# Patterns. Each line: pattern|reason. Order matters only for output clarity.
# Use word boundaries where applicable to reduce false positives.

declare -a PATTERNS=(
  # 9Router / AI gateway internals
  '9Router|Gateway name is internal to SFFMC development'
  ':20128|Gateway port is internal'
  ':20129|:20130|:20131|:20132|Internal 9Router port bindings'
  'prefix-proxy|9Router internal term'
  'ocg/|Internal 9Router provider prefix'
  'minimax/|Internal 9Router provider prefix'
  '/cx/|Internal 9Router provider prefix'
  '/gemini/|Internal 9Router provider prefix'
  'recrec/|Internal 9Router provider prefix'

  # SFFMC-internal agent names (these are SFFMC's own agent harness, not user-facing)
  '(^|[^a-zA-Z])orchestrator([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])librarian([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])fixer([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])oracle([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])designer([^a-zA-Z]|$)|SFFMC internal agent name'
  'pal-specialist|SFFMC internal agent name'

  # Anthropic model names (SFFMC does not depend on Anthropic APIs)
  'claude-sonnet-4-20250514|Anthropic model name not used by SFFMC'
  'claude-opus-4-7|Anthropic model name not used by SFFMC'
  'claude-haiku-4-5|Anthropic model name not used by SFFMC'

  # OpenCode framework terms that SFFMC does not own
  'slim v2|OpenCode framework term, not SFFMC'
  'oh-my-opencode|Upstream OpenCode plugin, not SFFMC'

  # Internal infrastructure paths and hosts
  '/data/projects|User-local path not portable'
  '/home/opencode|User-local path not portable'
  '192\.168\.|Internal LAN IP range'
  'nipogi-e3b|Internal hostname'
  'maggot|Internal hostname'
  'opencode-sandbox|Sandbox project name is not SFFMC'
  'maksw20|Maintainer personal info (use Makswww20@gmail.com only)'
  'sk-6b99ddb4183dcb1b|Rotated 9Router API key (was leaked in v0.9.0)'

  # Fabricated provenance
  'formerly Claude Code|Incorrect OpenCode provenance'
  'Claude Code fork|Incorrect OpenCode provenance'

  # Config system: SFFMC uses ~/.config/SFFMC/, not MiMo-style
  '~\?/.mimo/|SFFMC config lives in ~/.config/SFFMC/, not ~/.mimo/'
  '/.mimocode/|SFFMC config lives in ~/.config/SFFMC/, not .mimocode/'

  # Stale count claims (block on the 15 vs 18 mismatch)
  '15\s+(markdown\s+)?skills|Stale count: SFFMC has 18 compose skills'
  '15\s+compose\s+skills|Stale count: SFFMC has 18 compose skills'
)

# Files / directories to exclude (history, backups, deps).
EXCLUDE_RE='(\.bak-pre-|node_modules|dependencies/|\.git/|/dist/|\.sffmc/|\.slim/)'

FAIL=0
HITS=0

# For each pattern, run grep across the scope. Count matches outside the
# exclude regex. Report per-pattern and exit non-zero on any hit.
for entry in "${PATTERNS[@]}"; do
  pat="${entry%%|*}"
  reason="${entry#*|}"

  # Use ripgrep if available, else grep -rE. Scope to .md only.
  if command -v rg >/dev/null 2>&1; then
    # rg: search only markdown files in scope, exclude noise paths.
    rg_glob_extras=()
    for f in "${EXCLUDE_FILES[@]}"; do
      rg_glob_extras+=(--glob "!**/$f")
    done
    out=$(rg --no-heading --line-number \
          --type=md --type-add 'yaml:*.yaml' --type=yaml \
          --type-add 'py:*.py' --type=py --type-add 'ts:*.ts' --type=ts \
          --glob '!CHANGELOG.md' \
          --glob '!LICENSE*' \
          --glob '!docs/long-agent-test-v090-report.md' \
          --glob '!node_modules' --glob '!dependencies' --glob '!dist' \
          --glob '!*.bak-pre-*' \
          "${rg_glob_extras[@]}" \
          -e "$pat" \
          README.md CONTRIBUTING.md docs/ packages/*/README.md \
          packages/*/config/*.example.yaml packages/*/skills/*.md \
          scripts/*.py packages/*/src/*.ts shared/src/*.ts 2>/dev/null || true)
  else
    # Fallback: shell out to find + grep. Slower, but no rg dep.
    find_filter_excludes=(
      -not -path "./CHANGELOG.md"
      -not -path "./LICENSE*"
      -not -path "*/node_modules/*"
      -not -path "./dependencies/*"
      -not -path "*/dist/*"
      -not -regex ".*\.bak-pre-.*"
      -not -path "./.git/*"
    )
    for f in "${EXCLUDE_FILES[@]}"; do
      find_filter_excludes+=(-not -path "./$f")
    done
    out=$(find . \( -name "*.md" -o -name "*.yaml" -o -name "*.py" -o -name "*.ts" \) \
        "${find_filter_excludes[@]}" \
        2>/dev/null \
        | xargs grep -nE "$pat" 2>/dev/null || true)
  fi

  if [ -n "$out" ]; then
    FAIL=1
    HITS=$((HITS + 1))
    echo "[FAIL] pattern: /$pat/  reason: $reason"
    echo "$out" | sed 's/^/  /'
    echo ""
  fi
done

if [ $FAIL -eq 0 ]; then
  echo "[OK] audit-public-content: no internal-infrastructure leaks found"
  echo "  Scanned: ${SCOPE[*]}"
  echo "  Patterns: ${#PATTERNS[@]}"
  exit 0
else
  echo "[FAIL] audit-public-content: $HITS pattern(s) matched"
  echo "  Fix the leaks above and re-run."
  exit 1
fi
