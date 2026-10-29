# Installing, updating and reaching cctabs

> Read when installing the Tabby plugin, when the skill text may be older than the CLI, or when driving a Tabby on another machine over SSH.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Getting cctabs running

```bash
which cctabs || ls "$(npm prefix -g)/bin/cctabs" 2>/dev/null
```

If found, use whichever path works. If `cctabs` is on PATH, use it directly. Otherwise use the full path from `npm prefix -g`.

If not found, ask the user: "cctabs isn't installed yet — want me to install it globally with npm?" If they agree, run:

```bash
npm install -g @generativereality/cctabs
```

Do not modify PATH or npm configuration beyond this.

### Check the installed version isn't stale

On your first cctabs invocation in a session, look at the version banner cctabs prints (`(@generativereality/cctabs vX.Y.Z)`) and at any `[cctabs] OUTDATED ...` warning line (on stderr, so `--json` output stays clean). If you see the warning — or if the banner version is older than the version in this skill's `plugin.json` — tell the user:

> *"Your installed cctabs is `vX.Y.Z`; the current release is `vA.B.C`. Want me to upgrade with `npm install -g @generativereality/cctabs@latest` before continuing?"*

Don't silently work around an outdated CLI: detection heuristics, command flags, and bug fixes diverge between versions, so misbehavior on the user's machine is often "binary on PATH lags behind the plugin docs you're reading." The Claude Code marketplace plugin update path only refreshes this skill — the npm-installed CLI binary is a separate channel and must be upgraded explicitly.

⚠️ **This text can itself be the stale half**: the cached skill can lag the CLI on PATH by several releases. If `cctabs <cmd> --help` disagrees with this file, trust the binary; `cctabs doctor` says when this skill is older than the CLI.

### A one-time plugin install is needed

Tabby is the terminal cctabs supports, and it **needs a small companion plugin** that exposes a localhost HTTP API the cctabs CLI talks to.

**Wave Terminal is not supported.** It was a working backend through 0.4.x and was withdrawn in 0.5.0 — tabs opened, but the Claude session inside them often never started. Under Wave, every cctabs command exits with a pointer to Tabby. If a user is on Wave, the move is: install Tabby, install the companion plugin, then `cctabs restore` — their conversations live in `~/.claude/projects` and are unaffected by the terminal switch.

You don't need to detect this proactively — every cctabs command will fail with a self-documenting error if the plugin isn't running:

```
cctabs Tabby plugin not reachable at http://127.0.0.1:3300.
  reason: …
Install + restart Tabby in one shot from inside a Tabby tab:
  cctabs install-tabby-plugin
…
```

When you see that error, ask the user once:

> *"You're in Tabby and the cctabs plugin isn't installed. I can `cctabs install-tabby-plugin --yes`: it installs the plugin, saves every open session, closes the tabs, restarts Tabby and restores them all in a new tab. OK?"*

On approval, run `cctabs install-tabby-plugin --yes`. **Your current turn ends when Tabby quits**; this session comes back with the rest. `--no-restart` installs only, for a user who will restart Tabby themselves.

`cctabs doctor` is also available for a deliberate environment check: it reports the detected terminal (and how it was detected), whether a login+interactive shell can find `node`, and — on Tabby — whether the cctabs plugin answers its localhost health endpoint. Useful if something feels off, but **not required as a preflight** since every command fails loudly on its own.

What the auto-install does step by step, the manual and GUI installs, and driving a remote Tabby over SSH: [references/install.md](install.md).

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
