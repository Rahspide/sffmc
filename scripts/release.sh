#!/bin/bash
# scripts/release.sh — automate SFFMC release flow
#
# Usage:
#   ./scripts/release.sh <version> <notes-file> [--check]
#
# What it does:
#   1. Verifies clean working tree, on main, tag not yet existing
#   2. Runs 4 pre-commit gates (test, typecheck, audit, sffmc_health)
#   3. Prepends ## v<version> section to CHANGELOG.md (title from notes line 1)
#   4. git commit + git tag -a
#
# Example:
#   cat > /tmp/notes.md <<EOF
#   Tweak ergonomics
#
#   - scripts/release.sh: automate the release flow
#   - CHANGELOG auto-update on tag
#   EOF
#   ./scripts/release.sh 0.7.6 /tmp/notes.md
#
# Options:
#   --check    Run gates only, don't modify anything (CI-friendly)

set -euo pipefail

CHECK_ONLY=false
if [[ "${3:-}" == "--check" ]]; then
  CHECK_ONLY=true
fi

VERSION="${1:?usage: $0 <version> <notes-file> [--check]}"
NOTES_FILE="${2:?usage: $0 <version> <notes-file> [--check]}"

DATE=$(date +%Y-%m-%d)
TITLE=$(head -1 "$NOTES_FILE" | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*$//')
if [[ -z "$TITLE" ]]; then
  echo "[release] ERROR: notes file first line is empty (used as changelog title)"
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

# --- 1. Sanity checks ---
if [[ -n "$(git status --porcelain)" ]]; then
  echo "[release] ERROR: working tree not clean. Commit or stash first."
  git status --short
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "[release] WARNING: not on 'main' branch (you're on '$CURRENT_BRANCH')"
  read -r -p "Continue anyway? [y/N] " REPLY
  [[ "$REPLY" =~ ^[Yy]$ ]] || exit 1
fi

if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "[release] ERROR: tag v$VERSION already exists"
  git log -1 --oneline "v$VERSION"
  exit 1
fi

if ! bun --version >/dev/null 2>&1; then
  echo "[release] ERROR: bun not in PATH"
  exit 1
fi

echo "[release] ok: clean tree, branch=$CURRENT_BRANCH, version=v$VERSION, title='$TITLE'"

# --- 2. Run 4 gates ---
echo ""
echo "[release] === gate 1/4: bun test ==="
bun test 2>&1 | tail -5

echo ""
echo "[release] === gate 2/4: bun run typecheck ==="
if ! bun run typecheck >/dev/null 2>&1; then
  echo "[release] typecheck FAILED"
  bun run typecheck
  exit 1
fi
echo "[release] typecheck ok"

echo ""
echo "[release] === gate 3/4: load-order audit ==="
python3 scripts/audit-load-order.py 2>&1 | tail -5

echo ""
echo "[release] === gate 4/4: sffmc_health ==="
HEALTH_JSON=$(bun run scripts/run-health.ts 2>&1)
echo "$HEALTH_JSON" | python3 -c "import json, sys; d=json.load(sys.stdin); print('ok:', d['ok'], '|', d['summary'])" 2>/dev/null || {
  echo "[release] sffmc_health FAILED (could not parse output)"
  echo "$HEALTH_JSON"
  exit 1
}
HEALTH_OK=$(echo "$HEALTH_JSON" | python3 -c "import json, sys; d=json.load(sys.stdin); print('1' if d.get('ok') else '0')")
if [[ "$HEALTH_OK" != "1" ]]; then
  echo "[release] sffmc_health reports failures — see above"
  exit 1
fi

echo ""
echo "[release] === all 4 gates passed ==="

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo "[release] --check: not committing, not tagging"
  exit 0
fi

# --- 3. Update CHANGELOG (prepend) ---
echo ""
echo "[release] === updating CHANGELOG.md ==="
TMPFILE=$(mktemp)
{
  echo "# SFFMC Changelog"
  echo ""
  echo "## v${VERSION} — ${TITLE} (${DATE})"
  echo ""
  # Skip the title line (line 1) from notes, prepend the rest under the header
  tail -n +2 "$NOTES_FILE" | sed '/^$/d; s/^/- /' | sed 's/^- $//'
  echo ""
  # Now append the rest of the existing CHANGELOG (skip its first line which is "# SFFMC Changelog")
  tail -n +2 CHANGELOG.md
} > "$TMPFILE"
mv "$TMPFILE" CHANGELOG.md
echo "[release] CHANGELOG.md updated"

# --- 4. Commit + tag ---
echo ""
echo "[release] === commit + tag ==="
git add CHANGELOG.md
git commit -m "docs: v${VERSION} changelog — ${TITLE}" 2>&1 | tail -3

git tag -a "v${VERSION}" -m "v${VERSION} — ${TITLE}

$(cat "$NOTES_FILE")"

echo ""
echo "[release] === done ==="
echo "  commit: $(git rev-parse --short HEAD)"
echo "  tag:    v$VERSION"
echo ""
echo "verify with:"
echo "  git tag -l"
echo "  git show v$VERSION"
echo "  git log --oneline -3"
