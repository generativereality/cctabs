---
layout: home
title: cctabs — Run a fleet of Claude Code sessions across your terminal tabs
description: cctabs gives every Claude Code session its own named terminal tab, with a CLI to open, fork, resume, and read them, and a skill so Claude Code can drive the whole fleet itself. Runs in Tabby, with no tmux.

hero:
  name: cctabs
  text: Run a fleet of Claude Code sessions across your terminal tabs
  tagline: "Every Claude Code session gets its own named terminal tab (auth, api, frontend) that you can scroll and switch to like any other tab, plus a CLI to open, fork, and read them. Claude Code can drive the whole thing itself, which is how you get to ten or fifteen sessions without losing track of them."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/generativereality/cctabs

features:
  - title: Claude spawns its own sessions
    details: Install one plugin and Claude Code can see your tabs. It checks what's already running, opens new tabs, starts sessions in them, and coordinates work across the ones it opened, without you relaying anything by hand.
  - title: Real terminal tabs
    details: Every session runs in a native tab of the terminal you already use, so the whole fleet is visible in the tab bar, switching is a click, and scrolling and copy-paste behave the way they always do. There is no tmux underneath and no TUI to live in.
  - title: From four sessions to fifteen
    details: Most people open three or four Claude Code sessions by hand and stall there, because the bookkeeping grows faster than the work does. cctabs hands that bookkeeping to Claude, so ten or fifteen parallel sessions cost you roughly what four did.
  - title: Restore after a computer restart
    details: After a reboot, say "restore my cctabs now after a computer restart" and Claude reopens every named tab, resumes each session where it left off, and puts the tab bar back in its original order.
  - title: Fork to explore
    details: Branch any conversation into a new independent tab and try a different approach in it, with the original left exactly as it was. If the fork turns out better you keep it and close the one you started from.
  - title: One plugin install
    details: Install the Claude Code plugin and the CLI comes with it, along with the skill that lets Claude use it. There is nothing to configure and nothing else to install. Runs in Tabby.
---

## Get started in 60 seconds

The simplest path: open [Claude Code](https://claude.ai/code) in any terminal and paste this prompt:

> Visit https://cctabs.com/guide/getting-started and walk me through setting up cctabs on this machine.

Claude will install Tabby, the `tabby-cctabs` companion plugin, and the cctabs Claude Code plugin — then verify with `cctabs sessions`.

Or follow the manual steps in the [Getting Started guide](/guide/getting-started).

### Supported terminals

| Terminal | Platforms | Companion install |
|---|---|---|
| **[Tabby](https://tabby.sh)** | macOS · Linux · Windows | Tabby → Settings → Plugins → search **cctabs** → install → restart |

> **Platform status:** cctabs is actively tested on **macOS**. Tabby on Linux and Windows hasn't been tried yet, but its plugin format is portable, so it might Just Work.
>
> **Wave Terminal was supported through 0.4.x and was withdrawn in 0.5.0** — tabs would open but the Claude session inside them often never started. Running cctabs under Wave now exits with a pointer to Tabby. Your sessions are unaffected: they live in `~/.claude/projects`, so `cctabs restore` reopens them by name once Tabby is set up.
>
> **Hitting issues on Linux, Windows, or another terminal?** Point Claude Code at [the cctabs repo](https://github.com/generativereality/cctabs), share the error, and ask it to investigate and open a PR. Adding a new terminal backend means implementing the small [`TerminalAdapter`](https://github.com/generativereality/cctabs/blob/main/src/core/adapter.ts) interface — [`src/core/tabby.ts`](https://github.com/generativereality/cctabs/blob/main/src/core/tabby.ts) is the worked example.

Then, inside Claude Code:

```
❯ /plugin marketplace add generativereality/plugins
❯ /plugin install cctabs@generativereality
❯ /reload-plugins
```

The plugin ships the `cctabs` CLI **and** a Claude Code skill — so Claude can drive your tabs without you switching to a separate tool.
