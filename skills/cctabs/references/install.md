# Installing, updating and reaching cctabs

> Read when installing the Tabby plugin by hand, when the skill text may be older than the CLI, or when driving a Tabby on another machine over SSH.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## When this skill text is the stale half

⚠️ **The drift runs the other way too: THIS TEXT can be the stale half.** Because
those are two channels, the cached skill can lag the CLI by several releases. On
2026-09-16 a driver was reading
`<config-dir>/plugins/cache/generativereality/cctabs/0.5.0/skills/cctabs/SKILL.md`
— **691 lines, zero occurrences of the word "trust"** — while the CLI on PATH was
`0.5.3` and the source skill was 1030 lines and already documented the failure
that then cost it five tabs. The cache path carries the version, so compare it
against `cctabs --version`:

```bash
ls -d "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/plugins/cache/*/cctabs/*/ && cctabs --version
```

If the cached version is behind, ask the user to run `/plugins` → Marketplaces →
Update generativereality. Until they do, treat anything *absent* from this file as
"possibly just missing here", not "not a thing" — and prefer `cctabs <cmd> --help`
from the installed binary over this text where the two could disagree.

### Auto-install + auto-restart (recommended)

```bash
cctabs install-tabby-plugin --yes
```

What it does, in order:
1. `npm install --legacy-peer-deps --prefix <tabby-plugins-dir> tabby-cctabs`
2. Captures the current claude session id from `~/.claude/projects/<slug>/`
3. Spawns a detached background worker that quits Tabby, waits for it to die, reopens it, then opens a new tab running `claude --resume <id> --fork-session` in your current cwd.

**Other Tabby tabs in the same window get killed.** Tabby's session recovery may or may not bring them back. Use `--no-restart` to skip step 3 if the user wants control.

### Manual install (fallback)

```bash
TABBY_PLUGINS="$HOME/Library/Application Support/tabby/plugins"
mkdir -p "$TABBY_PLUGINS"
[ -f "$TABBY_PLUGINS/package.json" ] || echo '{"private":true}' > "$TABBY_PLUGINS/package.json"
npm install --legacy-peer-deps --prefix "$TABBY_PLUGINS" tabby-cctabs
# then ask the user to quit + reopen Tabby
```

`--legacy-peer-deps` is required: the plugin's peer deps (`tabby-core`, `@angular/*`, …) live inside Tabby itself, not on npm. Tabby's GUI plugin manager handles this internally.

Linux: replace `~/Library/Application Support/tabby` with `${XDG_CONFIG_HOME:-$HOME/.config}/tabby`.
Windows: `%APPDATA%\tabby`.

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
