#!/usr/bin/env bash
# SFFMC cleanroom gate — verify no external deps, plugin refs, or workflow leaks.
# Exit 0 on pass, 1 on fail. Run via `bun run check:cleanroom`.
#
# SELF-EXCLUSION: this file is a string-matching gate. It contains the patterns
# it greps for. Always exclude itself from scans.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

FAIL=0
log() { echo "[cleanroom] $*"; }
err() { echo "[cleanroom][FAIL] $*" >&2; FAIL=1; }

# Allowlist regex for common false positives (terms that LOOK like internal IDs).
ALLOWLIST_REGEX='\b(HTTP/[12]|HTTP/1\.1|V[12]\.0|V[0-9]+[ ]+plugin|D1[ ]+\((Cloudflare|database)\)|L[12][ ]+\(cache\)|X11|X86|X64|X86_64|ARM64|CRUD|ACID|API[ ]?(key|endpoint)?|SDK|UI|UX|CI|CD|CLI|GUI|REPL|ASCII|UTF-?8|URL|URI|UUID|MD5|SHA-?[0-9]+|HMAC|PBKDF|BCRYPT|XSS|CSRF|DDOS|MITM|SPA|PWA|SSR|SSG|ISR|DOM|V8|JIT|AOT|FIFO|LIFO|OOPS|OOP|TLS|SSL|RPC|gRPC|GraphQL|CORS|CDN|ORM|ODM|ETL|ELT|TDD|BDD|SLA|SLO|SLI|CSP|JSON|YAML|CSV|TSV|JS|TS|NOSQL|SQL|HPC|TPC|PC[0-9]+|T[0-9]+(\.[0-9]+)*|P[0-9]+-[0-9]+|API)\b'

# Generic ID pattern: catches F2.5, P1, M5a, CRIT-1, etc.
# Use grep -P for proper Perl regex (better word boundary, hex escapes).
GENERIC_ID_REGEX='\b[A-Z][0-9]+(?:\.[0-9]+)?(?:\x27[a-z]?)?\b'

# File extensions to scan (extended in 2026-06-20 to cover bypass vectors).
SCAN_INCLUDE=(
  "*.ts" "*.js" "*.mjs" "*.cjs" "*.tsx" "*.jsx"
  "*.json" "*.md" "*.sh" "*.bash"
  "*.yml" "*.yaml" "*.toml" "*.cfg" "*.ini" "*.env"
  "*.lock" "*.sql" "*.proto" "*.html" "*.css"
  "*.txt" "*.example"
)
SCAN_INCLUDE_ARGS=()
for ext in "${SCAN_INCLUDE[@]}"; do SCAN_INCLUDE_ARGS+=("--include=$ext"); done

# Files to always exclude (gate, audit, and check patterns themselves).
# v0.15.3 cleanup: removed dead references to `packages/compose/`,
# `packages/agentic/` (dissolved in v0.15.0 P-1 consolidation into
# `packages/cognition/`), and the legacy `shared/` directory.
EXCLUDE_PATTERNS=(
  "node_modules"
  "scripts/cleanroom-terms.txt"
  "scripts/check-cleanroom.sh"
  "scripts/audit-public-content.sh"
  "scripts/long-agent-test-v090.ts"
  "packages/cognition/src/compose/skills/"
  "packages/cognition/src/health/src/index.ts"
  "packages/safety/codemap.md"
  "packages/memory/codemap.md"
  "packages/runtime/codemap.md"
  "packages/utilities/codemap.md"
  "codemap.md"
)

# --- 1. External URLs (allow only github.com/Rahspide/sffmc, localhost, 127.0.0.1) ---
log "1/4 external URLs..."
EXTERNAL_URLS=$(grep -rPn "${SCAN_INCLUDE_ARGS[@]}" \
  'https?://(?![Pp]?(github\.com/Rahspide/sffmc|github\.com/davisjam/safe-regex|localhost|127\.0\.0\.1|registry\.npmjs\.org|agentskills\.io|opensource\.org|spdx\.org)\b)' \
  packages/ bin/ scripts/ .drone.yml 2>/dev/null \
  | grep -vE "/(test|spec)/" || true)
if [ -n "$EXTERNAL_URLS" ]; then
  err "external URLs found (only github.com/Rahspide/sffmc and localhost allowed):"
  echo "$EXTERNAL_URLS" | head -10 >&2
fi

# --- 2. Internal paths/hosts ---
log "2/4 internal paths/hosts..."
INTERNAL=$(grep -rEn "${SCAN_INCLUDE_ARGS[@]}" \
  -e "/data/projects" -e "/home/opencode" -e "nipogi" -e "maggot" -e "tailscale" \
  -e "192\.168\.[0-9]+" -e "100\.[0-9]+\.[0-9]+\.[0-9]+" \
  packages/ bin/ scripts/ docs/ *.md 2>/dev/null || true)
for ex in "${EXCLUDE_PATTERNS[@]}"; do INTERNAL=$(echo "$INTERNAL" | grep -v "$ex" || true); done
if [ -n "$INTERNAL" ]; then
  err "internal paths/hosts found:"
  echo "$INTERNAL" | head -10 >&2
fi

# --- 3. Workflow terms and internal labels ---
log "3/4 workflow terms and internal labels..."

BANNED_TERMS_FILE="scripts/cleanroom-terms.txt"
if [ ! -f "$BANNED_TERMS_FILE" ]; then
  err "banned-terms file missing: $BANNED_TERMS_FILE"
  exit 1
fi

# 3a. Explicit banned terms from catalog
while IFS= read -r term; do
  [[ -z "$term" || "$term" =~ ^# ]] && continue
  HITS=$(grep -rEn "\b${term}\b" "${SCAN_INCLUDE_ARGS[@]}" \
    packages/ bin/ scripts/ docs/ *.md 2>/dev/null || true)
  for ex in "${EXCLUDE_PATTERNS[@]}"; do HITS=$(echo "$HITS" | grep -v "$ex" || true); done
  HITS=$(echo "$HITS" | grep -vE "$ALLOWLIST_REGEX" || true)
  if [ -n "$HITS" ]; then
    err "banned term '${term}':"
    echo "$HITS" | head -3 >&2
  fi
done < "$BANNED_TERMS_FILE"

# 3b. Generic [A-Z]\d+(\.\d+)? pattern (catches unlabeled IDs)
GENERIC_ID_HITS=$(grep -rPn "$GENERIC_ID_REGEX" "${SCAN_INCLUDE_ARGS[@]}" \
  --exclude-dir=dist --exclude-dir=node_modules \
  packages/ bin/ scripts/ docs/ *.md 2>/dev/null || true)
for ex in "${EXCLUDE_PATTERNS[@]}"; do GENERIC_ID_HITS=$(echo "$GENERIC_ID_HITS" | grep -v "$ex" || true); done
# Filter out regex literals in source code (e.g., `[a-zA-Z0-9]` matches Z0).
GENERIC_ID_HITS=$(echo "$GENERIC_ID_HITS" | grep -v "const m = /" || true)
GENERIC_ID_HITS=$(echo "$GENERIC_ID_HITS" | grep -v "/^.*\[a-z" || true)
GENERIC_ID_HITS=$(echo "$GENERIC_ID_HITS" | grep -vE "$ALLOWLIST_REGEX" || true)
if [ -n "$GENERIC_ID_HITS" ]; then
  err "generic ID pattern (likely internal project ID):"
  echo "$GENERIC_ID_HITS" | head -10 >&2
fi

# --- 4. External plugin/gateway references ---
log "4/4 external plugin/gateway references..."
PLUGIN_HITS=$(grep -rEn --include="*.ts" --include="*.js" --include="*.mjs" --include="*.cjs" --include="*.json" \
  -e "9router" -e "icm-hybrid" -e "icm-bridge" -e "@icm/" -e "@mcp/" -e "opencode-root" -e "@tarquinen/opencode-dcp" \
  packages/ bin/ scripts/ 2>/dev/null \
  | grep -vE "/(test|spec)/" \
  || true)
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
