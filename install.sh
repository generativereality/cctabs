#!/usr/bin/env bash
# Install cctabs — Claude Code tab manager
set -euo pipefail

echo "Installing cctabs..."

if command -v npm &>/dev/null; then
    npm install -g @generativereality/cctabs
elif command -v bun &>/dev/null; then
    bun install -g @generativereality/cctabs
else
    echo "Error: npm or bun required" >&2
    exit 1
fi

echo ""
echo "✓ cctabs installed"
echo ""
echo "Prerequisites:"
echo "  • Tabby (https://tabby.sh) — brew install --cask tabby"
echo "  • The cctabs companion plugin, installed from inside a Tabby tab:"
echo "    cctabs install-tabby-plugin"
echo ""
echo "Quick start:"
echo "  cctabs sessions                        # see what's running"
echo "  cctabs new myproject ~/Dev/myproj      # open a new session"
echo ""
echo "Claude Code skill:"
echo "  mkdir -p .claude/skills/cctabs"
echo "  curl -fsSL https://raw.githubusercontent.com/generativereality/cctabs/main/skills/cctabs/SKILL.md \\"
echo "    -o .claude/skills/cctabs/SKILL.md"
