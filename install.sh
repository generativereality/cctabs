#!/usr/bin/env bash
# Install herd — agent session manager for AI coding tools
set -euo pipefail

echo "Installing herd..."

if command -v npm &>/dev/null; then
    npm install -g @generativereality/agentherder
elif command -v bun &>/dev/null; then
    bun install -g @generativereality/agentherder
else
    echo "Error: npm or bun required" >&2
    exit 1
fi

echo ""
echo "✓ herd installed"
echo ""
echo "Prerequisites:"
echo "  • Wave Terminal with Accessibility permission:"
echo "    System Settings → Privacy & Security → Accessibility → Wave ✓"
echo ""
echo "Quick start:"
echo "  herd                             # see what's running"
echo "  herd new myproject ~/Dev/myproj  # open a new session"
echo ""
echo "Claude Code skill:"
echo "  mkdir -p .claude/skills/herd"
echo "  curl -fsSL https://raw.githubusercontent.com/generativereality/agentherder/main/.claude/skills/herd/SKILL.md \\"
echo "    -o .claude/skills/herd/SKILL.md"
