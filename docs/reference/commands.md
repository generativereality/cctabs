---
title: Command Reference — cctabs
description: Complete reference for all cctabs CLI commands — sessions, new, resume, fork, close, rename, scrollback, send, and config.
---

# Commands

## cctabs (default)

Running `cctabs` with no arguments is equivalent to `cctabs sessions`.

## cctabs sessions

List all tabs with session status.

```bash
cctabs sessions
```

Output:
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

Status values:
- `● active` — Claude Code UI detected in scrollback
- `○ idle` — `claude` in last line but no active UI
- `  terminal` — plain shell, no Claude running

## cctabs list

List all workspaces, tabs, and blocks with IDs.

```bash
cctabs list
```

## cctabs new

Open a new tab and launch `claude`.

```bash
cctabs new <name> [dir] [-w workspace]
```

| Argument | Description |
|----------|-------------|
| `name` | Tab name (required) |
| `dir` | Working directory (default: current) |
| `-w, --workspace` | Target Wave workspace |

## cctabs resume

Open a new tab and run `claude --continue`.

```bash
cctabs resume <name> [dir]
```

## cctabs fork

Fork a session into a new tab using `claude --resume <session-id> --fork-session`.

```bash
cctabs fork <tab-name> [-n new-name]
```

| Argument | Description |
|----------|-------------|
| `tab-name` | Source tab (name or ID prefix) |
| `-n, --name` | Name for the new tab (default: `<source>-fork`) |

## cctabs close

Close a tab by name or ID prefix.

```bash
cctabs close <name-or-id>
```

## cctabs rename

Rename a tab.

```bash
cctabs rename <name-or-id> <new-name>
```

## cctabs scrollback

Read terminal output for a tab or block.

```bash
cctabs scrollback <tab-or-block> [lines]
```

Default: last 50 lines. Accepts a tab name, tab ID prefix, or block ID prefix.

## cctabs send

Send input to a tab or terminal block.

```bash
cctabs send <tab-or-block> [text] [--file <path>]
```

| Source | Example |
|--------|---------|
| Inline text | `cctabs send auth "yes\n"` |
| File | `cctabs send auth --file ~/prompts/task.txt` |
| Stdin | `echo "do the thing" \| cctabs send auth` |

Escape sequences in inline text: `\n` = Enter, `\t` = Tab.

Accepts a tab name (resolves to its first terminal block), or a block ID prefix.

## cctabs config

Show the config file path and current values.

```bash
cctabs config
```

## cctabs export

Bundle a tab (or every tab in a workspace) and its Claude session(s) into a tarball
you can move to another machine, then resume there with `cctabs import`.

```bash
cctabs export auth                              # → ./cctabs-export-auth-<ts>.tar.gz
cctabs export auth --out ~/Downloads/auth.tar.gz
cctabs export --all                             # every tab in the current workspace
cctabs export --all --workspace tabby
```

The archive layout is:

```
meta.json                     # cctabsExportVersion, source machine, tab list
tabs/<name>/manifest.json     # name, cwd, sessionId, claudeProjectSlug
tabs/<name>/session.jsonl     # Claude conversation
```

Tabs without a resolved Claude session (e.g. a terminal that never started Claude)
are skipped with a reason.

## cctabs import

Import a tarball produced by `cctabs export`: copies each session jsonl into the
local `~/.claude/projects/<slug>/`, then opens a tab and resumes the session.

```bash
cctabs import ./auth.tar.gz                    # restore at the original cwd
cctabs import ./auth.tar.gz --cwd ~/Dev/myapp  # single-tab archives only
cctabs import ./team-export.tar.gz --dry-run   # show what would happen
cctabs import ./auth.tar.gz --force            # overwrite a session id that already exists locally
```

If the target cwd doesn't exist on this machine, the entry is skipped with a hint to
clone the repo first. Absolute paths inside the conversation log itself are *not*
rewritten — they'll reference the source machine's paths historically, but Claude
adapts to the actual current cwd on resume.

## cctabs doctor

Diagnose Wave Terminal DB issues — currently the orphan-tabid bug that breaks
`wsh blocks list`. See [Troubleshooting](../guide/troubleshooting.md) for the
full background.

```bash
cctabs doctor              # diagnose only
cctabs doctor --fix        # back up the DB and apply the fix interactively
cctabs doctor --fix --yes  # skip the confirmation prompt
```
