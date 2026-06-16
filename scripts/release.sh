#!/usr/bin/env bash
# scripts/release.sh — publish SFFMC packages to npm
# Triggered by .drone.yml on tag push (v*.*.*)
# Local usage: bun run scripts/release.sh --actual
set -euo pipefail

MODE="${1:---dry-run}"

if [ "$MODE" != "--dry-run" ] && [ "$MODE" != "--actual" ]; then
  echo "Usage: $0 [--dry-run|--actual]"
  exit 1
fi

# Publish order: sub-features first (no deps), composites last
PACKAGES=(
  watchdog rules auto-max eos-stripper log-whitelist
  extra max-mode workflow compose health
  safety memory agentic
)

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SUCCESS=0
FAILED=""

for pkg in "${PACKAGES[@]}"; do
  PKG_DIR="$ROOT_DIR/packages/$pkg"
  if [ ! -f "$PKG_DIR/package.json" ]; then
    echo "  ⊘ $pkg — no package.json, skipping"
    continue
  fi

  PKG_NAME=$(python3 -c "import json; print(json.load(open('$PKG_DIR/package.json'))['name'])")
  PKG_VERSION=$(python3 -c "import json; print(json.load(open('$PKG_DIR/package.json'))['version'])")

  echo ""
  echo "→ $PKG_NAME@$PKG_VERSION ($MODE)"

  if [ "$MODE" = "--dry-run" ]; then
    if (cd "$PKG_DIR" && npm publish --dry-run --access public 2>&1 | tail -3); then
      SUCCESS=$((SUCCESS+1))
    else
      FAILED="$FAILED $pkg"
    fi
  else
    if (cd "$PKG_DIR" && npm publish --access public 2>&1 | tail -3); then
      SUCCESS=$((SUCCESS+1))
    else
      FAILED="$FAILED $pkg"
      echo "✗ Failed to publish $pkg — stopping"
      break
    fi
  fi
done

echo ""
echo "==================================="
echo "Published: $SUCCESS / ${#PACKAGES[@]}"
if [ -n "$FAILED" ]; then
  echo "Failed:$FAILED"
  exit 1
fi
