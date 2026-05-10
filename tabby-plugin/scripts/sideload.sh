#!/usr/bin/env bash
# Copy the built plugin into Tabby's plugins folder for dev iteration.
#
# Usage: npm run sideload
#
# Tabby looks for plugins under:
#   macOS:   ~/Library/Application Support/tabby/plugins/node_modules/<plugin>
#   Linux:   ~/.config/tabby/plugins/node_modules/<plugin>
#   Windows: %APPDATA%\tabby\plugins\node_modules\<plugin>
#
# The plugin name *as Tabby sees it* is the npm package's `name` field
# stripped of any scope ("@generativereality/" → ""). Tabby's plugin loader
# enumerates folders directly under node_modules/.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
PKG="$ROOT/package.json"

if [[ ! -f "$DIST/index.js" ]]; then
  echo "✘ dist/index.js missing — run 'npm run build' first." >&2
  exit 1
fi

# Strip scope from the package name (Tabby's plugin manager registers under bare names).
PKG_NAME=$(node -p "require('$PKG').name.replace(/^@[^/]+\//, '')")

case "$(uname)" in
  Darwin) PLUGIN_DIR="$HOME/Library/Application Support/tabby/plugins" ;;
  Linux)  PLUGIN_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/tabby/plugins" ;;
  *)      echo "Unsupported platform $(uname). Set TABBY_PLUGINS env var to override." >&2; exit 1 ;;
esac

if [[ -n "${TABBY_PLUGINS:-}" ]]; then PLUGIN_DIR="$TABBY_PLUGINS"; fi

TARGET="$PLUGIN_DIR/node_modules/$PKG_NAME"
mkdir -p "$TARGET/dist"
cp -R "$DIST/." "$TARGET/dist/"
cp "$PKG" "$TARGET/package.json"
[[ -f "$ROOT/README.md" ]] && cp "$ROOT/README.md" "$TARGET/README.md"

echo "✓ Sideloaded $PKG_NAME → $TARGET"
echo "  Restart Tabby to pick up changes (Cmd+Q + reopen)."
