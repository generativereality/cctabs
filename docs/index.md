---
layout: home
title: cctabs — Self-aware agentic coding across terminal tabs
description: Install one plugin and Claude spawns 10, 15 parallel sessions on its own — each in a named terminal tab you can see, scroll, and switch to. No tmux. No TUI.

hero:
  name: cctabs
  text: Self-aware agentic coding across terminal tabs
  tagline: "Install one plugin and Claude spawns 10, 15 parallel sessions on its own — each in a named tab (auth, api, frontend) you can see, scroll, and switch to. No tmux. No TUI."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/generativereality/cctabs

features:
  - title: Claude spawns its own sessions
    details: Install one plugin and Claude Code gains tab-awareness. It sees what's running, opens new tabs, starts new sessions, and coordinates work across them — automatically.
  - title: Real terminal tabs
    details: Every session runs in a native terminal tab. See them all in your tab bar. Click to switch. Scroll the output. Copy-paste normally. Not a TUI. Not tmux. Your actual terminal.
  - title: Go from 4 sessions to 15
    details: Most people manually open a few Claude Code sessions. With cctabs, Claude handles the session management — so you scale to 10, 15 parallel sessions without the overhead.
  - title: Restore after a computer restart
    details: After a reboot, just say "restore my cctabs now after a computer restart" — Claude reopens every named tab and resumes each session where it left off.
  - title: Fork to explore
    details: Branch any conversation into a new independent tab. Try alternative approaches without disrupting the original. Keep what works, close what doesn't.
  - title: One plugin install
    details: Install the Claude Code plugin and the CLI comes with it. No config files. No tmux. No dependencies. Works in Tabby (recommended, cross-platform) or Wave Terminal.
---

## Get started in 60 seconds

The simplest path: open [Claude Code](https://claude.ai/code) in any terminal and paste this prompt:

> Visit https://cctabs.com/guide/getting-started and walk me through setting up cctabs on this machine. I want to use Tabby Terminal _(or "Wave Terminal" if you prefer macOS-native)_.

Claude will install the terminal app, the `tabby-cctabs` companion plugin (or grant Wave's Accessibility permission), and the cctabs Claude Code plugin — then verify with `cctabs sessions`.

Or follow the manual steps in the [Getting Started guide](/guide/getting-started).

### Supported terminals

| Terminal | Platforms | Companion install |
|---|---|---|
| **[Tabby](https://tabby.sh)** (recommended) | macOS · Linux · Windows | Tabby → Settings → Plugins → search **cctabs** → install → restart |
| **[Wave Terminal](https://waveterm.dev)** | macOS | Grant Accessibility permission in System Settings |

Then, inside Claude Code:

```
❯ /plugin marketplace add generativereality/plugins
❯ /plugin install cctabs@generativereality
❯ /reload-plugins
```

The plugin ships the `cctabs` CLI **and** a Claude Code skill — so Claude can drive your tabs without you switching to a separate tool.
