---
title: Command Reference — cctabs
description: Complete reference for all cctabs CLI commands — sessions, new, resume, fork, close, rename, scrollback, send, and config.
---

# Commands

Every command below needs the CLI on your PATH — see
[Getting Started](/guide/getting-started) if you haven't installed it yet.

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
- `? unknown` — nothing readable in the scrollback, usually a tab whose shell died with the terminal

### `--json`

Emit the same listing as machine-readable JSON, one entry per tab:

```bash
cctabs sessions --json > snapshot.json
```

Each entry carries `{block_id, tab_id, name, cwd, current, status, last_line, session_id}`, plus `backend` and `config_dir` when the session belongs to a non-default Claude account. The shape is exactly what `cctabs restore --manifest` consumes, so the two pipe together directly.

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
| `-w, --workspace` | Target workspace (legacy Wave concept; no-op on Tabby) |
| `-c, --color` | Tab colour — see [`cctabs color`](#cctabs-color) |

## cctabs resume

Bring a named session back with `claude --resume <id>`, reusing that tab if it's
still open and creating one otherwise. A tab whose shell died is rebuilt rather
than typed into.

```bash
cctabs resume <name> [dir]
cctabs resume <name> [dir] -s <session-id>   # when several sessions share the name
cctabs resume <name> [dir] -b <preset>       # force a backend / Claude account
cctabs resume <name> [dir] -m <model>        # override the model
cctabs resume <name> [dir] -c <colour>      # colour the tab, reused or new
```

The session is looked up by its `--name` under `dir` (default: cwd), across every
Claude config dir — so a session belonging to a second Claude account is found
too, and is resumed **under that account** without any flags. Precedence for the
backend: explicit `-b`, then the account the session was found in, then the one
inherited from the calling tab (`CCTABS_ACTIVE_BACKEND`). The success line says
which was used.

## cctabs restore

Bring back every tab that lost its session — the usual after a reboot or a
terminal restart. Tabs still running Claude are left alone.

```bash
cctabs restore                    # scan this window's tabs, resume each by name
cctabs restore --dry              # print the decisions without acting on any of them
cctabs restore ~/Dev/myapp        # only consider sessions under one directory
```

For each dead tab it finds the session by name (searching every project directory
in every Claude config dir), then either types the resume into the tab's live
shell or, when the shell is gone too, rebuilds the tab around it. The
pre-restore tab order is restored once everything is back.

`--dry` runs exactly the same planning a real run does and stops before executing,
so what it prints is what a real run would do — including tabs it would close as
duplicates.

### Manifest mode

Drive the restore from an explicit list instead of scanning:

```bash
cctabs restore --manifest snapshot.json [--create-missing] [--dry]
cctabs sessions --json | cctabs restore --manifest - --create-missing
```

Entries are `{name, dir, session_id?, backend?, config_dir?}`; `dir` and `cwd` are
interchangeable, and `cctabs sessions --json` output is accepted as-is (both its
`{workspaces: [{sessions: […]}]}` shape and a bare array). Without
`--create-missing`, entries with no existing tab are reported and skipped.
`backend` / `config_dir` are optional — restore infers the account from wherever
it finds the session id.

The manifest's order is the order the tab bar is rebuilt in.

## cctabs backends

List the available backend presets — model providers and alternate Claude
accounts. See [Configuration](/guide/configuration#backends).

```bash
cctabs backends
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
| `-b, --backend` | Backend preset / Claude account |
| `-c, --color` | Tab colour — see [`cctabs color`](#cctabs-color) |

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

## cctabs color

Set or clear a tab's colour.

```bash
cctabs color <name-or-id> blue
cctabs color <name-or-id> "#0275d8"
cctabs color <name-or-id> none        # clear it
```

Accepts Tabby's own palette names — `blue`, `green`, `orange`, `purple`, `red`,
`yellow` — plus `none`, or any 3-, 6- or 8-digit hex value. An unrecognised
colour is rejected before the terminal is touched: Tabby binds the value
straight into a CSS `background-color`, so a bogus one would silently fail to
render rather than complain.

The palette names resolve to the exact hex values Tabby's right-click →
**Color** menu uses, so a colour set here is indistinguishable from a hand-set
one — including that menu showing the matching radio button as selected.

`--color` on [`new`](#cctabs-new), [`resume`](#cctabs-resume) and
[`fork`](#cctabs-fork) does the same at launch, and colours ride along with the
tab's creation so it never renders uncoloured first. `resume` also colours a tab
it reused rather than created. Without `--color`, a tab takes its backend
preset's `color`, else `[defaults] color` — see
[Configuration](/guide/configuration).

Colouring requires a `tabby-cctabs` plugin advertising the `tab-color`
capability. Against an older plugin, `cctabs color` warns and exits non-zero
(colouring was the whole job), while `new`/`resume`/`fork` warn once and open the
tab anyway.

### Surviving a reboot

Tabby persists a tab's colour across its own restart, but that isn't sufficient:
[`cctabs restore`](#cctabs-restore) *recreates* a dead tab — closes it and spawns
a replacement — and a fresh tab starts uncoloured. So colour travels the same
route `permission_mode` does:

- `cctabs sessions --json` records `color` per tab.
- `restore --manifest` hands it back.
- A scan-mode `restore` reads the colour off the tab it is about to replace.
- An entry with no recorded colour takes whatever the config implies for its
  backend — `[backends.<name>] color`, else `[defaults] color`. Since the backend
  is inferred from the Claude config dir the session was found in, a rule like
  "the enterprise account's tabs are blue" holds after a reboot with nothing
  recorded per tab at all.

A recorded `null` means "deliberately uncoloured" and is honoured rather than
treated as missing.

## cctabs sort

Reorder the tab bar by Claude session activity, most recently active first.

```bash
cctabs sort [--dry] [--reverse]
```

| Flag | Effect |
|------|--------|
| `--dry`, `-n` | Print the planned order without applying it (`--dry-run` also works) |
| `--reverse`, `-r` | Oldest first instead of newest |

Activity is the modification time of the newest Claude transcript whose title
matches the tab's name, across every [config dir](/guide/configuration#backends).
Tabs with no matching session — a plain shell, an editor — sink to the end and
keep their relative order, so sorting never scrambles your non-Claude tabs.

Requires the Tabby companion plugin's reordering API.

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

Run environment checks and report what's wrong. See
[Troubleshooting](../guide/troubleshooting.md) for the full background.

```bash
cctabs doctor
```

Checks:

- **Terminal** — which backend was detected, and how (env sniffing, a
  `CCTABS_TERMINAL` override, or the Tabby plugin probe used over SSH).
- **Spawned shell PATH** — whether a login+interactive `zsh` can find `node`.
  This is the canonical macOS PATH-sourcing failure: when it breaks, tabs spawn
  but Claude Code and plugin MCPs can't start inside them.
- **Tabby cctabs plugin** — whether the companion plugin answers on
  `127.0.0.1:3300`, and which version.

Exits non-zero if any check fails. It's safe to run under an unsupported
terminal — it reports what it found rather than refusing, which is the point.

::: info Changed in 0.5.0
`--fix` and `--yes` are gone. They only ever repaired Wave Terminal's
orphan-tabid database bug, and the Wave backend was removed in 0.5.0.
:::
