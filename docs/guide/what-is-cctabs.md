---
title: What is cctabs? — cctabs
description: cctabs is Claude Code with tabs — a session manager that uses native terminal tabs instead of tmux to run parallel Claude Code sessions.
---

# What is cctabs?

cctabs is Claude Code with tabs. It's a CLI that lets you open, resume, fork, inspect, and close Claude Code sessions — each one in its own native terminal tab.

## The problem

Running multiple Claude Code sessions in parallel is powerful, but the tooling around it is rough:

- **tmux-based tools** (claude-squad, agent-deck, ccmanager) wrap everything in panes. Scrolling is awkward. Copy-paste breaks. You're fighting tmux instead of using your terminal.
- **Manual tab management** works but has no memory — you lose track of which tab is which session, which directory it's in, and whether it's still active.
- **Claude Code's own session names** (`--name`) already sync to terminal tab titles, but nothing automates this.

## The approach

Your terminal tabs are already the multiplexer. A tab per session is the right UI. cctabs just gives you a CLI to drive it:

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
