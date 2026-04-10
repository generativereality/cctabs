---
name: cctabs
description: Manage Claude Code sessions across terminal tabs (NOT browser tabs) — list running sessions, open new ones, fork, close, inspect output, and send input. Use this when working with multiple parallel Claude Code sessions in terminal tabs.
---

You are managing Claude Code sessions using the `cctabs` CLI.

**Important:** "tabs" here means **terminal tabs** (e.g. Wave Terminal tabs), NOT browser tabs. Each terminal tab runs its own Claude Code session. This skill is for managing those terminal-based Claude Code sessions — not for browser automation.

## First: Ensure cctabs is available

```bash
which cctabs || ls "$(npm prefix -g)/bin/cctabs" 2>/dev/null
```

If found, use whichever path works. If `cctabs` is on PATH, use it directly. Otherwise use the full path from `npm prefix -g`.

If not found, ask the user: "cctabs isn't installed yet — want me to install it globally with npm?" If they agree, run:

```bash
npm install -g @generativereality/cctabs
```

Do not modify PATH or npm configuration beyond this.

---

Each Claude Code session runs in its own **terminal tab**. `cctabs` lets you — and other Claude Code sessions — introspect and orchestrate the full session fleet.

## Quick Reference

```bash
cctabs sessions                          # list all tabs with session status
cctabs list                              # list all workspaces, tabs, and blocks
cctabs new <name> [dir] [-w workspace] [-p "prompt"] [-f file]  # new tab + claude
cctabs resume <name> [dir]               # resume last session (reuses tab or creates one)
cctabs fork <tab-name> [-n new-name]     # fork session into new tab (--resume <id> --fork-session)
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # rename a tab
cctabs scrollback <tab-or-block> [n]    # read terminal output (default: 50 lines)
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs config                            # show config and path
```

## Workflow: Checking What's Running

Before starting new sessions, always check what's already active:

```bash
cctabs sessions
```

Output example:
```
Sessions
==================================================

Workspace: work (current)

  [a1b2c3d4] "auth" ◄  ~/Dev/myapp
    ● active
  [e5f6a7b8] "api"  ~/Dev/myapp
    ○ idle
  [c9d0e1f2] "infra"  ~/Dev/myapp
      terminal
    last: $ git status
```

## Workflow: Opening a Session Batch

```bash
cctabs new auth ~/Dev/myapp
cctabs new api ~/Dev/myapp
cctabs new infra ~/Dev/myapp
```

Each tab is automatically named and the claude session name is synced to the tab title.

## Workflow: Resuming a Session

`cctabs resume` finds the latest session ID for the directory and runs `claude --resume <id>`.
If the named tab still exists, it reuses it. If not, it creates a new tab.

```bash
cctabs resume auth ~/Dev/myapp       # reuses "auth" tab if it exists, otherwise creates one
cctabs resume api ~/Dev/myapp
```

**Use `cctabs resume` instead of `cctabs new` when you want to continue a previous conversation.**
`cctabs new` always starts a fresh Claude session. `cctabs resume` picks up where the last session left off.

## Workflow: Forking a Session

Use `fork` when you want to explore an alternative approach without disrupting the original.
`cctabs fork` finds the latest session ID for the source tab and opens a new tab with
`claude --resume <id> --fork-session`. The source tab is not modified.

```bash
cctabs fork auth                    # creates "auth-fork" tab
cctabs fork auth -n "auth-v2"       # creates "auth-v2" tab
```

The forked session shares full conversation history up to the fork point, then diverges independently.

## Workflow: Spawning a Parallel Agent

As a Claude Code session, you can spawn a sibling session to work on a parallel task:

**Preferred: pass the initial task directly to `cctabs new`** using `--prompt` or `--file`. This polls internally until Claude's `❯` prompt appears before sending — no race condition:

```bash
cctabs new payments ~/Dev/myapp --prompt "implement the billing endpoint"
cctabs new payments ~/Dev/myapp --file /tmp/task.txt
```

If you need to send a task after the fact, poll first:

```bash
cctabs new payments ~/Dev/myapp
# Poll until ❯ appears (typically 10-15s with MCP servers)
cctabs scrollback payments 5   # repeat until you see ❯
cctabs send payments --file /tmp/task.txt
cctabs send payments "yes\n"   # quick replies
```

**Do NOT call `cctabs send` immediately after `cctabs new`** — Claude is still starting up and the text will land as raw shell commands.

## Workflow: Monitoring Another Session

```bash
cctabs scrollback auth          # last 50 lines
cctabs scrollback auth 200      # last 200 lines
```

## Workflow: Sending Input to a Session

```bash
cctabs send auth "yes\n"        # approve a tool call
cctabs send auth "\n"           # press enter (confirm a prompt)
cctabs send auth "/clear\n"     # send a slash command
cctabs send auth --file ~/prompts/task.txt   # send a full prompt from file
echo "do the thing" | cctabs send auth       # pipe via stdin
```

## Workflow: Worktrees

**Always point tabs at the repo root — never at a manually-created worktree directory.** Claude Code manages worktrees itself via `claude --worktree <name>`, which creates `.claude/worktrees/<name>/` inside the repo and handles branch creation and cleanup automatically.

### New isolated session (new branch, Claude manages everything)

```bash
cctabs new feature-name ~/Dev/myapp --worktree
# Equivalent to: cd ~/Dev/myapp && claude --worktree "feature-name" --name "feature-name"
# Claude creates: ~/Dev/myapp/.claude/worktrees/feature-name/
# Claude creates branch: worktree-feature-name
```

### Existing branch — ask Claude to enter the worktree mid-session

```bash
cctabs new hiring ~/Dev/myapp          # open tab at repo root
cctabs send hiring "Enter a worktree for branch z.old/new-hire-ad and ..."
# Claude will use EnterWorktree tool to set up isolation
```

### Do NOT manage git worktrees manually

```bash
# ❌ WRONG — do not create worktree dirs yourself and pass them to cctabs new
git worktree add ~/Dev/myapp-feature branch
cctabs new feature ~/Dev/myapp-feature

# ✅ RIGHT — always use repo root; let Claude Code manage the worktree
cctabs new feature ~/Dev/myapp --worktree
```

**Why:** Manually created worktree dirs placed outside the repo confuse Claude Code's session tracking, project memory lookup (`.claude/` is in the main repo), and CLAUDE.md resolution. Claude Code's built-in worktree support keeps everything co-located under `.claude/worktrees/` and handles cleanup on session exit.

## Workflow: Cleanup

```bash
cctabs sessions                        # find idle/terminal tabs
cctabs close old-feature               # close by name (prefix match)
cctabs close e5f6a7b8                  # close by block ID prefix
```

## Tab Naming Conventions

Name tabs after the **project or task**:
- `auth` — authentication work
- `api` — API service
- `infra` — infrastructure
- `pr-1234` — specific PR work
- `auth-v2` — forked attempt

## Notes

- Tab names are matched by exact name or prefix (case-insensitive)
- Block IDs can be abbreviated to the first 8 characters
- `cctabs new` and `cctabs resume` automatically pass `--name <tab-name>` to claude, syncing the session display name with the tab title
- Configured `claude.flags` in `~/.config/cctabs/config.toml` are applied to every session
- `cctabs send` resolves tab names to their terminal block automatically
