---
layout: home
title: cctabs — Claude Code with Tabs
description: Manage parallel Claude Code sessions from a single CLI. Native terminal tabs, no tmux.

hero:
  name: cctabs
  text: Claude Code with tabs
  tagline: Parallel sessions. Native tabs. No tmux.
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/generativereality/cctabs

features:
  - title: No tmux
    details: Uses your terminal's native tab API. Each session is a real tab, not a tmux pane. Scrolling and copy-paste work exactly as you expect.
  - title: Fork sessions
    details: Branch any conversation into a new independent tab. Try alternative approaches without disrupting the original.
  - title: Claude Code skill included
    details: Claude Code itself can call cctabs to check what sessions are running, spawn parallel agents, and coordinate across tabs.
  - title: Config-driven defaults
    details: Set flags like --dangerously-skip-permissions once in config and they apply to every session automatically.
  - title: Tab name = session name
    details: Terminal tab title and Claude Code session name stay in sync natively. You always know which tab is which.
  - title: Scriptable
    details: Plain CLI output, composable in shell scripts, Claude Code hooks, and automation workflows.
---
