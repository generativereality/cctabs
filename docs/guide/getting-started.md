---
title: Getting Started — cctabs
description: Install cctabs as a Claude Code plugin or via npm, then open your first multi-session terminal workflow in under a minute.
---

# Getting Started

## Prerequisites

- **[Tabby](https://tabby.sh)** with the
  [`tabby-cctabs`](https://www.npmjs.com/package/tabby-cctabs) plugin installed.
  It stays responsive with many open tabs and is fast on tab creation and
  scrollback reads, which matters once Claude is orchestrating 10+ sessions.
  Tabby runs on macOS, Linux, and Windows; cctabs is actively tested on
  **macOS**, and Linux/Windows haven't been tried yet but the plugin format is
  portable, so it might Just Work. If you hit issues on another platform or
  want a new terminal supported, point Claude Code at
  [the repo](https://github.com/generativereality/cctabs), share the
  error, and ask it to investigate + open a PR — the backend interface is
  small ([`TerminalAdapter`](https://github.com/generativereality/cctabs/blob/main/src/core/adapter.ts)).

  ::: warning Wave Terminal is no longer supported
  Wave was supported through 0.4.x and was withdrawn in **0.5.0**: tabs would
  open, but the Claude session inside them often never started. cctabs now
  exits with a pointer to Tabby when it detects Wave. Your conversations are
  not affected — they live in `~/.claude/projects`, so `cctabs restore` brings
  them back by name once Tabby is set up.
  :::
- [Claude Code](https://claude.ai/code) — `claude` on your PATH
- Node.js ≥ 20

**One-time setup:** install the cctabs plugin from Tabby → **Settings → Plugins** (search "cctabs"), or run `cctabs install-tabby-plugin` from inside a Tabby tab. To sideload a dev build instead, see [`tabby-plugin/README.md`](https://github.com/generativereality/cctabs/tree/main/tabby-plugin). Restart Tabby afterwards.

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
npm install -g @generativereality/cctabs
```

Verify:

```bash
cctabs --version
```

## First session

From inside Tabby, with the cctabs plugin running:

```bash
cctabs sessions
```

This shows all open tabs and whether they have active Claude Code sessions.

Open a new session:

```bash
cctabs new myproject ~/Dev/myproject
```

cctabs will:
1. Open a new Tabby tab
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
