---
title: Session Workflows — cctabs
description: Open session batches, fork conversations, resume after restarts, send input remotely, and read scrollback across Claude Code sessions.
---

# Session Workflows

## Opening a session batch

```bash
cctabs sessions                          # check what's already running

cctabs new auth ~/Dev/myapp
cctabs new api ~/Dev/myapp
cctabs new infra ~/Dev/myapp
```

Each tab is named automatically and the Claude session name is synced to the tab title via `--name`.

## Starting a session with an initial prompt

Use `-p` to send a prompt once Claude is ready, or `-f` to load it from a file:

```bash
cctabs new auth ~/Dev/myapp -p "implement JWT refresh token logic"
cctabs new api ~/Dev/myapp -f ~/prompts/api-task.txt
```

cctabs waits for Claude's prompt to appear before sending, so there's no race condition.

## Working in an isolated branch (worktree)

Use `-W` to launch Claude with `--worktree <name>`, creating an isolated git worktree:

```bash
cctabs new auth-experiment ~/Dev/myapp -W
```

This lets you run parallel sessions on the same repo without branches conflicting.

## Resuming after a restart

```bash
cctabs sessions    # see which tabs are terminal (no claude running)

cctabs resume auth ~/Dev/myapp
cctabs resume api ~/Dev/myapp
```

`resume` runs `claude --continue`, picking up the last conversation.

## Forking a session

Fork when you want to try an alternative approach without disrupting the original:

```bash
cctabs fork auth                   # creates "auth-fork"
cctabs fork auth -n auth-v2        # creates "auth-v2"
```

Under the hood: finds the most recent Claude session ID for that tab's directory, then opens a new tab with `claude --resume <session-id> --fork-session`.

## Reading a session without switching to it

```bash
cctabs scrollback auth          # last 50 lines (by tab name)
cctabs scrollback auth 200      # last 200 lines
cctabs scrollback abc12345      # by block ID prefix
```

## Sending input to a session

```bash
# By tab name (resolves to its terminal block automatically)
cctabs send auth "yes\n"           # approve a tool call
cctabs send auth "\n"              # press enter
cctabs send auth "/clear\n"        # send a slash command

# Send a full prompt from a file
cctabs send auth --file ~/prompts/task.txt

# Pipe via stdin
echo "please review this PR" | cctabs send auth
```

`\n` = Enter, `\t` = Tab.

## Targeting a workspace

```bash
cctabs new api ~/Dev/myapp -w work
```

Opens the new tab in the Wave workspace named "work".

## Cleanup

```bash
cctabs sessions                    # identify terminal tabs (no claude)
cctabs close old-feature           # close by name (prefix match)
cctabs close e5f6a7b8              # close by block ID prefix
```
