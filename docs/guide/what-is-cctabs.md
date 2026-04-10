---
title: What is cctabs? — cctabs
description: cctabs is a session manager for Claude Code that uses native terminal tabs instead of tmux. Learn how it compares to claude-squad, ccmanager, and agent-deck.
---

# What is cctabs?

cctabs is a session manager for AI coding tools — primarily Claude Code. It lets you open, resume, fork, inspect, and close terminal sessions from a single CLI, without tmux.

## The problem

Running multiple Claude Code sessions in parallel is powerful, but the tooling around it is rough:

- **tmux-based tools** (claude-squad, agent-deck, ccmanager) wrap everything in panes. Scrolling is awkward. Copy-paste breaks. You're fighting tmux instead of using your terminal.
- **Manual tab management** works but has no memory — you lose track of which tab is which session, which directory it's in, and whether it's still active.
- **Claude Code's own session names** (`--name`) already sync to terminal tab titles, but nothing automates this.

## The approach

cctabs takes a different view: **your terminal tabs are already the multiplexer**. A tab per session is the right UI. cctabs just gives you a CLI to drive it:

```bash
cctabs sessions        # what's running right now
cctabs new api ~/Dev/api
cctabs fork horizon    # branch this conversation
cctabs send abc123 "yes\n"
```

## What makes it different

| | cctabs | claude-squad | ccmanager | agent-deck |
|---|---|---|---|---|
| No tmux required | ✅ | ❌ | ❌ | ❌ |
| Terminal tabs as UI | ✅ | ❌ | ❌ | ❌ |
| Fork sessions | ✅ | ❌ | ❌ | ❌ |
| Tab title sync | ✅ | ❌ | ❌ | ❌ |
| Claude Code skill | ✅ | ❌ | ❌ | ❌ |

## Terminal support

Wave Terminal is supported today. Support for iTerm2, Ghostty, and Warp is planned — the adapter architecture is in place.
