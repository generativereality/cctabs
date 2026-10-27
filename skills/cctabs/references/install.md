# Installing, updating and reaching cctabs

> Read when installing the Tabby plugin, when the skill text may be older than the CLI, or when driving a Tabby on another machine over SSH.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## When this skill text is the stale half

The skill (the plugin marketplace) and the CLI (npm) update separately, so this text can lag the CLI by several releases. `cctabs doctor` says so: its `cctabs skill` line warns when the installed skill is older than the CLI, and says how to update it. Until the user updates, treat anything *absent* from this file as possibly just missing here, and prefer `cctabs <cmd> --help` where the two disagree.

### Auto-install + auto-restart (recommended)

```bash
cctabs install-tabby-plugin --yes
```

What it does, in order:
1. `npm install --legacy-peer-deps --prefix <tabby-plugins-dir> tabby-cctabs@0.2.1`
2. The same controlled restart as `cctabs restart-tabby`: saves every open session, closes the
   other tabs, quits and reopens Tabby, and restores everything in a new tab — this session
   included. See [restore-and-restart.md](restore-and-restart.md#restarting-tabby-or-the-computer).

Before 0.5.12 step 2 resumed "the newest session in this directory" — not necessarily this tab's
— as a `--fork-session` copy, and left the other tabs to Tabby's own recovery. Use `--no-restart`
to install only and restart Tabby yourself.

If it fails, it says why and leaves Tabby alone. `--legacy-peer-deps` is what it needs and a plain `npm install` lacks: the plugin's peer dependencies live inside Tabby, not on npm.

### Alternative: install via Tabby's GUI

If the user prefers, point them at Tabby → **Settings → Plugins**, search "cctabs", click install, then quit + reopen Tabby. Same end state.

Do not assume an unfamiliar terminal means cctabs is unusable — check `cctabs doctor` first, and note that over SSH the detection falls back to probing the Tabby plugin.

## Driving a remote Tabby over SSH

cctabs can open/list/close/send tabs on **another machine's** Tabby over SSH,
as long as that machine's cctabs plugin is running. The plugin listens on
`127.0.0.1:3300`, and an SSH session on the same host reaches it fine.

The only wrinkle: over SSH the parent terminal never exports `TERM_PROGRAM`,
so cctabs can't sniff the terminal from the environment. Two ways it copes:

- **Auto-fallback (usually nothing to do):** when env detection comes up
  `unknown`, cctabs probes the Tabby plugin on `127.0.0.1:3300` and, if it
  answers, treats the session as Tabby. So a bare
  `ssh host 'cctabs new foo "~"'` just works when the remote plugin is up.
- **Explicit override:** set `CCTABS_TERMINAL=tabby` (alias `CCTABS_BACKEND`)
  to force the Tabby backend regardless of `TERM_PROGRAM` — belt-and-braces
  when you don't want to rely on the probe, or to force a specific backend.

```bash
# Open a tab on the other Mac's Tabby, from here:
ssh motin@motin-mbp21.local 'cctabs new mbp21-task "~/Dev/proj"'
# Force the backend explicitly if you prefer:
ssh motin@motin-mbp21.local 'CCTABS_TERMINAL=tabby cctabs new mbp21-task "~/Dev/proj"'
```

Tabs are still **per-machine** — each host has its own Tabby + plugin, so a tab
opened via SSH lives on the remote machine. Verify a remote host is ready with
`ssh host 'cctabs doctor'`: it reports `Terminal — tabby (via plugin probe …)`
when the fallback is in play.
