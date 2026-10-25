---
layout: home
title: cctabs — Run 20+ Claude Code sessions in your own terminal tabs
description: "A Claude Code and Codex CLI fleet tab manager for people who prefer each session in its own native terminal tab, not tmux or a dashboard. It enables swift coordination of 20+ long-running sessions: Claude/Codex itself opens, reads and prompts the tabs, every tab comes back after a restart, and any tab can be moved to another account on demand, its session continuing intact."

hero:
  name: cctabs
  text: Run 20+ Claude Code sessions in your own terminal tabs
  tagline: "A fleet tab manager for Claude Code and Codex CLI, for people who prefer each session in its own native terminal tab: no tmux, no dashboard, so your keybindings and scrolling still work. Claude/Codex itself opens, reads and prompts the tabs, every tab comes back after a restart, and any tab can be moved to another account on demand, its session continuing intact."
  actions:
    - theme: brand
      text: Get Started
      link: /guide/getting-started
    - theme: alt
      text: View on GitHub
      link: https://github.com/generativereality/cctabs

features:
  - title: Built for 20+ sessions
    details: Around ten sessions you can still juggle by hand. Past that you need orchestration. cctabs names every tab, shows which sessions are busy and which are waiting for you, and lets Claude open, read and message the rest, so the fleet keeps growing without the bookkeeping growing with it.
  - title: Native tabs, not tmux
    details: Each session is an ordinary tab in your terminal. Your keybindings work, scrolling and copy-paste behave the way they do everywhere else, and switching is a click. There is no tmux underneath and no dashboard to live in.
  - title: Any account, any backend, per tab
    details: Run one tab on your own Claude account, the next on a client's or your company's, another on Codex CLI, Ollama Cloud or a local model. Tabs a session spawns stay on its account, and resume finds each session under the account it belongs to.
    link: /guide/configuration#multiple-claude-accounts
    linkText: Set up accounts
  - title: Out of quota? Move the session
    details: When one account runs out, move the session to another and pick it up right where it left off. cctabs copies the whole conversation, subagent history included, and opens it in a new tab under the other account.
    link: /reference/commands#cctabs-profile-copy
    linkText: profile-copy
  - title: Sessions talk across accounts
    details: Claude Code's own messaging between sessions only reaches sessions on the same account. With cctabs, any tab can read what another is doing and send it a prompt, whatever account or backend either one runs on, and the send checks that the message actually arrived.
  - title: Restore after a restart
    details: Restart the computer and every tab comes back, named, in its original order, resumed where it left off. cctabs can also restart Tabby itself, or the whole fleet onto a new Claude Code version, without losing a conversation.
    link: /guide/workflows#resuming-after-a-restart
    linkText: How restore works
  - title: Colours that mean something
    details: Colour tabs by hand, or set rules, one colour per Claude account or a default for every new tab, so you can tell at a glance what each one is. Colours survive a restart.
    link: /reference/commands#cctabs-color
    linkText: Tab colours
  - title: Tidy the tab bar
    details: Ask Claude to reorder the tabs by recent activity, newest first, or pin the handful you are working with to the front. Tabs without a Claude session keep their order at the end.
    link: /reference/commands#cctabs-sort
    linkText: cctabs sort
  - title: Suspend what you aren't using
    details: A suspended tab keeps its name, its place and its conversation, but runs no Claude, so it stops taking memory. It wakes on Enter, or when another tab sends it a message. A 60-tab fleet can come back asleep in seconds.
    link: https://github.com/generativereality/cctabs/blob/main/skills/cctabs/references/suspended-tabs.md
    linkText: Suspended tabs
---

## Why I built it

I usually have more than 50 Claude Code sessions open. I started cctabs for myself in March, and it has been how I work ever since: thousands of pull requests at work, most in private repos, have come out of sessions in its tabs. My team runs parallel sessions the same way, and it has taken our PR throughput up about four to five times. After people saw it in demos at work and at meetups, I kept adding what my team and others needed, so it is now something you can install too.

It grew release by release: Wave Terminal in April (0.1), Tabby and a backend per tab in May (0.3–0.4), moving a session to another Claude account in August (0.5), Windows 11 in September (0.5.4), and in October restore across a reboot, Codex tabs and a token that locks the plugin's API (0.5.12–0.7.0). The whole history is in the [changelog](/changelog).

— Fred Motin ([@motin](https://github.com/motin))

## Everything else it does

**Claude drives the fleet.** One plugin install gives Claude Code the CLI and a skill to use it. Claude checks what is already running, opens new tabs, starts sessions in them, reads their output and sends them work, without you relaying anything by hand. Pair it with Claude Code's [Remote Control](https://docs.anthropic.com/en/docs/claude-code/remote-control) and you steer the whole fleet from your phone.

**Fork to explore.** Branch any conversation into a new tab and try a different approach, with the original left exactly as it was. `--worktree` gives a new session its own branch and checkout.

**Check in without switching tabs.** `cctabs sessions` lists every session with its status; `scrollback` and `transcript` show what a tab is doing and what it has worked out.

**Names that stay put.** `cctabs rename` changes the tab title, the live session's name and the name `resume` looks for, together. A per-machine `prefix` keeps names apart when several machines share one Remote Control list.

**Move to another machine.** `cctabs export` packs a tab or a whole workspace, conversation included, and `cctabs import` opens it on the new laptop.

**Claude Code and Codex CLI.** cctabs runs both, and one fleet can mix them.

See [all commands](/reference/commands), or [how it compares](/guide/what-is-cctabs) to claude-squad, ccmanager and agent-deck.

## Get started in 60 seconds

The simplest path: open [Claude Code](https://claude.ai/code) in any terminal and paste this prompt:

> Visit https://cctabs.com/guide/getting-started and walk me through setting up cctabs on this machine.

Claude will install Tabby, the `tabby-cctabs` companion plugin, and the cctabs Claude Code plugin — then verify with `cctabs sessions`.

Or follow the manual steps in the [Getting Started guide](/guide/getting-started).

### Supported terminals

| Terminal | Platforms | Companion install |
|---|---|---|
| **[Tabby](https://tabby.sh)** | macOS · Linux · Windows | Tabby → Settings → Plugins → search **cctabs** → install → restart |

> **Platform status:** cctabs is tested on **macOS** and **Windows 11**. Tabby on Linux hasn't been tried yet, but its plugin format is portable, so it might Just Work.
>
> **Wave Terminal was supported through 0.4.x and was withdrawn in 0.5.0** — tabs would open but the Claude session inside them often never started. Running cctabs under Wave now exits with a pointer to Tabby. Your sessions are unaffected: they live in `~/.claude/projects`, so `cctabs restore` reopens them by name once Tabby is set up.
>
> **Hitting issues on Linux or another terminal?** Point Claude Code at [the cctabs repo](https://github.com/generativereality/cctabs), share the error, and ask it to investigate and open a PR. Adding a new terminal backend means implementing the small [`TerminalAdapter`](https://github.com/generativereality/cctabs/blob/main/src/core/adapter.ts) interface — [`src/core/tabby.ts`](https://github.com/generativereality/cctabs/blob/main/src/core/tabby.ts) is the worked example.

Then, inside Claude Code:

```
❯ /plugin marketplace add generativereality/plugins
❯ /plugin install cctabs@generativereality
❯ /reload-plugins
```

The plugin ships the `cctabs` CLI **and** a Claude Code skill — so Claude can drive your tabs without you switching to a separate tool.
