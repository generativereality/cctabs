---
name: cctabs
description: |
  cctab / cctabs / terminal tabs — open, list, fork, close, watch and drive Claude Code or Codex CLI sessions that each run in their own real Tabby terminal tab. The CLI is `cctabs` (also installed as `cctab`).

  The word "tab" is DECISIVE, and a subagent is NOT a tab. If the user says "tab" / "cctab" / "cctabs" — even paired with a task, and even when that task sounds like background or parallel work (e.g. "open a tab and fix Y asap") — they mean a real terminal tab running its own agent session: CALL THIS SKILL, never the Agent tool. Most common use: "open a tab with prompt <task>" maps directly to `cctabs new <name> [dir] --prompt "<task>"`. A subagent's output is invisible in the terminal and it cannot be attached to, resumed, watched or driven. Use the Agent tool ONLY when the user explicitly says "subagent", "background agent", or "in parallel without a new tab".

  TRIGGER when the user says any of: "open a tab", "open a new tab", "open a tab with prompt …", "open a tab and <do X>", "open a tab that <does X>", "open a new cctab" (singular alias), "spawn a tab", "a new cctabs session", "in another tab", "in a separate tab", "fork this tab", "list my tabs", "close that tab", "send to <tab>", "resume <name>" — anything that refers to a terminal tab running Claude Code. ALSO trigger for: "/cctabs", or Tabby tab management for Claude Code.

  NOT for: browser tabs (use browser-automation), tmux panes, or screen sessions.
---

You drive Claude Code and Codex CLI sessions that each run in their own **terminal tab** (Tabby, not a browser), with the `cctabs` CLI. This file is the core; each reference below says when to open it. Where this text and `cctabs <cmd> --help` disagree, trust the binary.

## Rules

1. **Look before you open.** `cctabs sessions` shows every tab: `● active`, `○ idle`, `terminal` (a shell), `? unreadable` (no output captured, which is NOT "dead": the pid line says something runs there).
2. **One bare `cctabs …` per Bash call.** No `cd …;` in front (the dir is an argument), nothing chained after, never two `cctabs new` in one call (two tabs: two calls). A user's `Bash(cctabs:*)` allow rule only covers a call that *is* a cctabs command; auto mode refused a chained one that opened tabs.
3. **Hand the task to `new` itself:** `--prompt "…"` for a line, `--path <file>` for anything longer (only the path crosses the prompt line; a pasted 6.8 KB brief once arrived as its last 756 bytes). Never `send` right after a bare `new`: Claude is still starting.
4. **The trust dialog.** In a folder Claude Code hasn't trusted, a new tab opens on "Do you trust this folder?", whose cursor starts on **No, exit**. cctabs answers it for the folder you named and sends nothing while any dialog is open (it prints what to run after). By hand it is `printf '\033[B' | cctabs send <tab>`, never a bare Enter. Never answer the one-time Bypass Permissions question: it is the user's. → [trust-gate.md](references/trust-gate.md)
5. **Editing a branch other than the checkout's → `--worktree`,** pointed at the repo root: `cctabs new fix-1789 ~/Dev/myapp --worktree`. Never pass a worktree folder you made yourself. → [worktrees.md](references/worktrees.md)
6. **Parallel tabs only for work that won't need merging** (separate repos, new folders, independent features). Subtasks on the same evolving code: subagents, or one after another. → [spawning.md](references/spawning.md)
7. **Before messaging a tab, read what it has said:** `cctabs transcript <tab>` (`scrollback` shows only the screen). Pick the owner by its branch, not its name. → [routing.md](references/routing.md)
8. **Read a send's last line and exit code.** `NOT SENT to …` (exit 1) means nothing arrived. A busy-tab or draft refusal is usually right: shorten, wait, or ask. → [sending.md](references/sending.md)
9. **Never close a tab without the user's OK,** and close by id. Ask: "These look idle: `x`, `y`. Close any?"
10. **Never guess your own tab name:** `cctabs whoami` (`unknown` is a real answer).
11. **Restarting Tabby or the computer:** `cctabs restart-tabby` / `cctabs prepare-reboot`, never by hand. Run once without `--yes` to show what it saves and closes, ask, then `--yes`; your turn ends with the tab. After a reboot: `cctabs restore --pending`. → [restore-and-restart.md](references/restore-and-restart.md)

## When a command fails on setup

- **Not installed:** ask, then `npm install -g @generativereality/cctabs`.
- **"Tabby plugin not reachable":** ask, then `cctabs install-tabby-plugin --yes` (it saves the tabs, restarts Tabby and restores them; your turn ends there).
- **`[cctabs] OUTDATED …` on stderr:** offer `npm install -g @generativereality/cctabs@latest`; the skill and the CLI update separately.
- Anything else: `cctabs doctor`. → [install.md](references/install.md), [troubleshooting.md](references/troubleshooting.md)

## Commands you will use

```bash
cctabs sessions [--json]                    # every tab and its state
cctabs new <name> [dir] --prompt "…"        # new tab with a task (--path <file> for a long one; -B keeps your tab in front)
cctabs new <name> [dir] --worktree          # its own git worktree
cctabs new <name> [dir] -b <preset>         # another account or model backend
cctabs new <name> [dir] --engine codex      # Codex CLI instead of Claude
cctabs resume <name> [dir]                  # continue that tab's last conversation
cctabs fork <tab> [-n new-name]             # same conversation, new tab
cctabs send <tab> "…"                       # type into a tab; --path <file> to hand it a file
cctabs transcript <tab> [n]                 # what it has said (last n messages)
cctabs scrollback <tab> [n]                 # what its screen shows
cctabs suspend <tab> / cctabs wake <tab>    # put a tab to sleep / wake it (send also wakes it)
cctabs whoami                               # this session's tab
cctabs close <id>                           # only with the user's OK
```

The rest (`restore`, `manifest`, `restart`, `export`/`import`, `profile-copy`, `rename`, `color`, `sort`, `backends`, `config`): [commands.md](references/commands.md), or `cctabs <cmd> --help`.

## References: read the one that fits, when it fits

- [spawning.md](references/spawning.md): is a tab the right tool; opening, resuming, forking, watching; the gotchas that cost the most.
- [reading-tabs.md](references/reading-tabs.md): what each status means, `whoami`, `transcript`.
- [sending.md](references/sending.md): every `send` form and refusal, `--verify`. Before driving a tab with more than a short reply.
- [routing.md](references/routing.md): which tab gets a message. Before relaying anything across a fleet.
- [trust-gate.md](references/trust-gate.md): the trust dialog, which folders show it, and what it has cost.
- [worktrees.md](references/worktrees.md): when to use `--worktree`, existing branches, a session whose worktree is gone.
- [restore-and-restart.md](references/restore-and-restart.md): restore after a reboot, manifests, `restart`, `restart-tabby`.
- [suspended-tabs.md](references/suspended-tabs.md): `suspend`/`wake`, `restore --suspended`. When a tab shows ⏸.
- [backends-and-accounts.md](references/backends-and-accounts.md): other providers, other Claude accounts, `profile-copy`.
- [codex.md](references/codex.md): Codex CLI tabs.
- [tabs.md](references/tabs.md): names, colours, `sort`, the `prefix` setting, how names are matched.
- [export-import.md](references/export-import.md): moving tabs to another machine.
- [remote-control.md](references/remote-control.md): Remote Control (`/rc`) across the fleet.
- [install.md](references/install.md): installing, updating, a remote Tabby over SSH.
- [troubleshooting.md](references/troubleshooting.md): timeouts, an overloaded Tabby.
- [commands.md](references/commands.md): every command, one line each.
