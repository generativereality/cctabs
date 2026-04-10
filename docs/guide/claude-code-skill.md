---
title: Claude Code Skill — cctabs
description: Let Claude Code orchestrate parallel sessions autonomously using the built-in cctabs skill. Spawn, fork, monitor, and send input across tabs.
---

# Claude Code Skill

The included skill lets Claude Code call `cctabs` itself — checking what sessions are running, spawning parallel agents, forking conversations, and sending input to coordinate across tabs.

## Install

Run these slash commands inside a [Claude Code](https://claude.ai/code) session:

```
❯ /plugin marketplace add generativereality/plugins
  ⎿  Successfully added marketplace: generativereality

❯ /plugin install cctabs@generativereality
  ⎿  ✓ Installed cctabs. Run /reload-plugins to activate.

❯ /reload-plugins
  ⎿  Reloaded: 1 plugin · 0 skills · 5 agents · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers
```

> **Note:** These are Claude Code slash commands, not shell commands. Type them at the `❯` prompt inside a Claude Code session.

This installs both the `cctabs` CLI and the skill. Updates are delivered via the plugin — run `/plugin update cctabs` to get the latest.

## What Claude can do with it

**Check what's running:**
```bash
cctabs sessions
```

**Spawn a parallel session and send it a task:**
```bash
cctabs new payments ~/Dev/myapp
cctabs send payments --file /tmp/task.txt
echo "implement the billing endpoint" | cctabs send payments
```

**Fork its own session to try an alternative approach:**
```bash
cctabs fork auth -n auth-v2
```

**Monitor a sibling session without switching to it:**
```bash
cctabs scrollback payments 100
```

**Approve a tool call in another session:**
```bash
cctabs send payments "yes\n"
```

## How it works

The skill (`SKILL.md`) is loaded into Claude Code's context when placed in `.claude/skills/herd/`. It gives Claude:

- The full command reference
- Workflow patterns for common multi-session tasks
- Tab naming conventions
- Auto-install logic for the CLI itself
