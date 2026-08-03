---
title: What is cctabs? — cctabs
description: cctabs is a session manager for Claude Code that uses native terminal tabs instead of tmux. Learn how it compares to claude-squad, ccmanager, and agent-deck.
---

# What is cctabs?

cctabs is a session manager for AI coding tools — primarily Claude Code. It lets you open, resume, fork, inspect, and close terminal sessions from a single CLI, without tmux.

## The problem

Running several Claude Code sessions in parallel works well, but most of the tooling around it puts a layer between you and your terminal:

- **tmux-based managers** (claude-squad, agent-deck) wrap every session in a pane, so scrolling gets awkward, copy-paste stops behaving the way it does everywhere else, and you end up spending attention on tmux that you wanted to spend on the code.
- **TUI dashboards** (ccmanager) skip tmux, but you get a full-screen app to live in instead, so reaching a session still goes through their interface rather than your own.
- **Doing it by hand** works and has no memory. After an hour you've stopped knowing which tab holds which session, and whether any given one is still running or quietly dead.
- **Claude Code's own session names** (`--name`) already sync to terminal tab titles, so your tab bar is nearly a session list on its own. Nothing automates the rest of it.

## The approach

cctabs takes a different view: **your terminal tabs are already the multiplexer**. A tab per session is the right UI. cctabs just gives you a CLI to drive it:

```bash
cctabs sessions        # what's running right now
cctabs new api ~/Dev/api
cctabs fork auth       # branch this conversation
cctabs send abc123 "yes\n"
```

## What makes it different

| | cctabs | claude-squad | ccmanager | agent-deck |
|---|---|---|---|---|
| Runs without tmux | ✅ | ❌ | ✅ | ❌ |
| Your terminal's own tabs are the UI | ✅ | ❌ | ❌ | ❌ |
| Fork a conversation into a new session | ✅ | not documented | copies context to a new worktree | ✅ |
| Claude Code can drive it itself (ships a skill) | ✅ | ❌ | ❌ | ❌ |

Checked July 2026 against each project's own README. These tools move quickly, so
confirm a row before you rely on it.

The two rows that are genuinely only cctabs are the second and the fourth. Every
other tool here, tmux-based or not, ends up being something you look at — a pane
layout or a dashboard. cctabs has no interface of its own at all: the tab bar you
already have is the session list, and the CLI is there so that Claude Code can
open, read, and coordinate those tabs without you driving it.

## Terminal support

Tabby is the backend cctabs supports. It's a small
[`TerminalAdapter`](https://github.com/generativereality/cctabs/blob/main/src/core/adapter.ts)
implementation, so adding another terminal is a contained piece of work rather
than a rewrite — if you want one supported, point Claude Code at
[the repo](https://github.com/generativereality/cctabs) and ask it to write the
adapter and open a PR.

Wave Terminal was a supported backend through 0.4.x and was **withdrawn in
0.5.0**: tabs would open, but the Claude session inside them often never
started. cctabs now exits with a pointer to Tabby when it detects Wave. Your
conversations aren't affected — they live in `~/.claude/projects`, so
`cctabs restore` brings them back by name once Tabby is set up.

cctabs is actively tested on macOS. Tabby on Linux and Windows hasn't been tried
yet, though its plugin format is portable so it may well work as-is.

## Installing it

The CLI, the Claude Code skill, and the terminal support all arrive together when
you install it as a Claude Code plugin, which takes three slash commands. See
[Getting Started](/guide/getting-started), then
[Session Workflows](/guide/workflows) for what to do with it once it's running.
