#!/usr/bin/env bash
# Sync cctabs plugin files to the generativereality/plugins marketplace repo
# and verify everything is in sync before publishing.
#
# Usage:
#   ./scripts/sync-plugin.sh          # sync + commit + push
#   ./scripts/sync-plugin.sh --check  # just verify (used by prepack)
#
# Expects the plugins repo at ../plugins (alongside this repo).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
PLUGINS_DIR="$REPO_ROOT/../plugins"
CHECK_ONLY=false
[ "${1:-}" = "--check" ] && CHECK_ONLY=true

if [ ! -d "$PLUGINS_DIR/.git" ]; then
  echo "Error: plugins repo not found at $PLUGINS_DIR"
  echo "Clone it:  git clone <plugins-repo-url> $(cd "$REPO_ROOT/.." && pwd)/plugins"
  exit 1
fi

VERSION=$(node -p "require('$REPO_ROOT/package.json').version")
PLUGIN_VERSION=$(node -p "require('$PLUGINS_DIR/plugins/cctabs/.claude-plugin/plugin.json').version")

ERRORS=0

# Check version match
if [ "$VERSION" != "$PLUGIN_VERSION" ]; then
  echo "MISMATCH: package.json=$VERSION but plugins repo plugin.json=$PLUGIN_VERSION"
  ERRORS=1
fi

# Check the whole skill directory matches: SKILL.md AND the references/ files it
# links to. Checking SKILL.md alone would publish a skill whose pointers lead
# nowhere.
if ! diff -rq "$REPO_ROOT/skills/cctabs" "$PLUGINS_DIR/plugins/cctabs/skills/cctabs" >/dev/null 2>&1; then
  echo "MISMATCH: skills/cctabs/ differs from plugins repo"
  diff -rq "$REPO_ROOT/skills/cctabs" "$PLUGINS_DIR/plugins/cctabs/skills/cctabs" 2>&1 | sed 's/^/  /' || true
  ERRORS=1
fi

if [ "$CHECK_ONLY" = true ]; then
  if [ "$ERRORS" -ne 0 ]; then
    echo ""
    echo "Run: ./scripts/sync-plugin.sh"
    exit 1
  fi
  echo "Plugins repo in sync (v$VERSION)"
  exit 0
fi

# Sync files
mkdir -p "$PLUGINS_DIR/plugins/cctabs/.claude-plugin" "$PLUGINS_DIR/plugins/cctabs/skills"
cp "$REPO_ROOT/.claude-plugin/plugin.json" "$PLUGINS_DIR/plugins/cctabs/.claude-plugin/plugin.json"
# Replace the skill directory wholesale, so a reference file removed here is
# removed there too.
rm -rf "$PLUGINS_DIR/plugins/cctabs/skills/cctabs"
cp -R "$REPO_ROOT/skills/cctabs" "$PLUGINS_DIR/plugins/cctabs/skills/cctabs"

cd "$PLUGINS_DIR"
if git diff --quiet; then
  echo "Plugins repo already up to date (v$VERSION)"
  exit 0
fi

git add plugins/cctabs
git commit -m "chore: sync cctabs to $VERSION"
git push

echo "Synced cctabs v$VERSION to plugins repo"
