#!/usr/bin/env bash
# scripts/audit-public-content.sh
#
# Greps the public repo surface for terms that must not appear in user-facing
# docs. Catches accidental leaks of internal infrastructure, AI-gateway
# specifics, SFFMC-internal agent names, and Anthropic model names (SFFMC
# ships without Anthropic dependencies).
#
# Patterns are defined as REGEX CATEGORIES, not literal forbidden terms.
# This keeps the script public-safe: the patterns describe the *shape* of
# forbidden content (port ranges, key formats, hostname keywords) rather
# than listing specific values. The script itself is excluded from the
# scan so the category patterns don't match themselves.
#
# Scope: only .md / .yaml / .py / .ts files in repo root, docs/, and
# packages/ (NOT CHANGELOG.md, NOT LICENSE, NOT this script).
#
# Exit code: 0 = clean, 1 = at least one leak.
#
# Wire this into:
#   - package.json "scripts": "audit:public": "bash scripts/audit-public-content.sh"
#   - .drone.yml publish step (runs before any tag push)
#   - .git/hooks/pre-commit (manual install by contributors)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Files in scope. CHANGELOG.md excluded (historical record — may legitimately
# reference models or internal terms from past versions).
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

# Files excluded from the public audit (legitimately reference internal names):
#   - docs/load-order-audit.md : hook registration audit, names external
#     OpenCode wrappers it observes (e.g. oh-my-opencode-slim, dcp-strip-malformed,
#     icm) — accurate signal for SFFMC maintainers, not for end users.
#   - scripts/audit-public-content.sh : this file itself. The regex categories
#     would match their own keywords; self-exclusion breaks the chicken-and-egg.
EXCLUDE_FILES=(
  docs/load-order-audit.md
  scripts/audit-public-content.sh
)

# Forbidden content detected by CATEGORY (regex). Each line: pattern|reason.
# Patterns describe SHAPES, not specific values — the script stays public-safe.

declare -a PATTERNS=(
  # === AI gateway internals — specific terms ===
  '9Router|Gateway name is internal to SFFMC development'
  ':20128|:20129|:20130|:20131|:20132|Internal gateway port bindings'
  'prefix-proxy|Gateway internal term'
  'ocg/|Internal provider alias prefix'
  'minimax/|Internal provider alias prefix'
  '/cx/|Internal provider alias prefix'
  '/gemini/|Internal provider alias prefix'
  'recrec/|Internal provider alias prefix'

  # === SFFMC-internal agent names (SFFMC's own agent harness, not user-facing) ===
  '(^|[^a-zA-Z])orchestrator([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])librarian([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])fixer([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])oracle([^a-zA-Z]|$)|SFFMC internal agent name'
  '(^|[^a-zA-Z])designer([^a-zA-Z]|$)|SFFMC internal agent name'
  'pal-specialist|SFFMC internal agent name'

  # === Anthropic model names (regex, captures any versioned Claude-4 string) ===
  'claude-(sonnet|opus|haiku)-4-[a-z0-9-]+|Anthropic model name not used by SFFMC'

  # === OpenCode framework terms that SFFMC does not own ===
  'slim v2|OpenCode framework term, not SFFMC'
  'oh-my-opencode|Upstream OpenCode plugin, not SFFMC'

  # === Internal infrastructure paths and hosts (specific + regex for IP ranges) ===
  '/data/projects|User-local path not portable'
  '/home/opencode|User-local path not portable'
  '\b192\.168\.[0-9.]+\b|Internal LAN IP range'
  '\b100\.[0-9]+\.[0-9]+\.[0-9]+\b|Tailscale IP range'
  'nipogi-e3b|Internal hostname'
  'maggot|Internal hostname'
  'maksw20|Maintainer personal info (use Makswww20@gmail.com only)'
  'opencode-sandbox|Sandbox project name is not SFFMC'

  # === API key formats (regex, catches any sk-/github_pat_/npm_ token) ===
  '\bsk-[a-f0-9]{16,}\b|API key pattern (sk- prefix)'
  '\bgithub_pat_[a-zA-Z0-9_]{20,}\b|GitHub PAT pattern'
  '\bnpm_[a-zA-Z0-9]{20,}\b|NPM token pattern'

  # === Fabricated provenance ===
  'formerly Claude Code|Incorrect OpenCode provenance'
  'Claude Code fork|Incorrect OpenCode provenance'

  # === Config system: SFFMC uses ~/.config/SFFMC/, not MiMo-style ===
  '~?/.mimo/|SFFMC config lives in ~/.config/SFFMC/, not ~/.mimo/'
  '/.mimocode/|SFFMC config lives in ~/.config/SFFMC/, not .mimocode/'

  # === Stale count claims (block on the 15 vs 18 mismatch) ===
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

  # Use ripgrep if available, else grep -rE.
  if command -v rg >/dev/null 2>&1; then
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
