---
title: Getting Started — cctabs
description: Install cctabs as a Claude Code plugin or via npm, then open your first multi-session terminal workflow in under a minute.
---

# Getting Started

## Prerequisites

- A supported terminal — either:
  - [Wave Terminal](https://waveterm.dev) (macOS), or
  - [Tabby](https://tabby.sh) (macOS, Linux, Windows) with the
    [`tabby-cctabs`](https://www.npmjs.com/package/tabby-cctabs)
    plugin installed.
- [Claude Code](https://claude.ai/code) — `claude` on your PATH
- Node.js ≥ 20

**One-time setup (Wave only):** Wave Terminal needs Accessibility permission to open new tabs:

> System Settings → Privacy & Security → Accessibility → Wave Terminal ✓

**One-time setup (Tabby only):** install the cctabs plugin from Tabby → **Settings → Plugins** (search "cctabs"), or sideload the dev build (see [`tabby-plugin/README.md`](https://github.com/generativereality/cctabs/tree/main/tabby-plugin)).

## Install

### As a Claude Code plugin (recommended)

The plugin installs both the `cctabs` CLI and the Claude Code skill in one step. Run these slash commands inside a [Claude Code](https://claude.ai/code) session:

```
❯ /plugin marketplace add generativereality/plugins
  ⎿  Successfully added marketplace: generativereality

❯ /plugin install cctabs@generativereality
  ⎿  ✓ Installed cctabs. Run /reload-plugins to activate.

❯ /reload-plugins
  ⎿  Reloaded: 1 plugin · 0 skills · 5 agents · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers
```

> **Note:** These are Claude Code slash commands, not shell commands. Type them at the `❯` prompt inside a Claude Code session.

### Via npm (CLI only)

This installs the `cctabs` CLI but does **not** include the Claude Code skill:

```bash
npm install -g cctabs
```

Verify:

```bash
cctabs --version
```

## First session

From inside Wave Terminal (or Tabby with the cctabs plugin running):

```bash
cctabs sessions
```

This shows all open tabs and whether they have active Claude Code sessions.

Open a new session:

```bash
cctabs new myproject ~/Dev/myproject
```

cctabs will:
1. Open a new terminal tab (Wave or Tabby — whichever you're running in)
2. Rename it to `myproject`
3. `cd` to `~/Dev/myproject`
4. Launch `claude --name myproject`

The tab title and Claude session name are in sync from the start.

## Add the Claude Code skill

If you installed via the plugin method above, the skill is already included — no extra steps needed.

If you installed via npm and want to add the skill separately:

```bash
mkdir -p .claude/skills/cctabs
curl -fsSL https://raw.githubusercontent.com/generativereality/cctabs/main/skills/cctabs/SKILL.md \
  -o .claude/skills/cctabs/SKILL.md
```

With the skill installed, Claude Code can call `cctabs sessions`, `cctabs new`, `cctabs fork`, and more to orchestrate parallel work autonomously.
