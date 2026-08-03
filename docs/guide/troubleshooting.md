---
title: Troubleshooting — cctabs
description: Diagnosing common cctabs failure modes — plugin reachability, PATH in spawned tabs, and the Wave Terminal removal.
---

# Troubleshooting

## cctabs exits with "no longer supports Wave Terminal"

Wave Terminal was a supported backend through 0.4.x. **Support was withdrawn in
0.5.0** and the adapter has been removed, so every command now exits with a
message pointing at Tabby.

The backend had degraded to the point where tabs would open but the Claude
session inside them often never started — a failure that looked like a cctabs
bug, took real effort to diagnose, and only ever affected the Wave path. Tabby
is where the work goes now.

### Moving to Tabby

Your conversations are not tied to the terminal — Claude Code stores them in
`~/.claude/projects`. Nothing was lost when Wave stopped working.

```bash
brew install --cask tabby
```

Then, from inside a Tabby tab:

```bash
cctabs install-tabby-plugin   # installs the companion plugin, restarts Tabby
cctabs restore                # reopens your sessions by name
```

`cctabs doctor` still runs under Wave — it won't manage tabs, but it will
confirm what it detected and what to do about it.

If you were relying on `cctabs doctor --fix` to clean up Wave's orphan-tabid
database bug, that flag is gone too; it only ever repaired Wave's SQLite
database. The SQL for a manual repair is preserved in the 0.4.x docs history
and in `notes/waveterm-blockslist-orphan-tabid.md` in the repo.

## Tabby: `cctabs sessions` exits with "Tabby plugin GET /api/tabs failed"

`cctabs` running in Tabby talks to the
[`tabby-cctabs`](https://www.npmjs.com/package/tabby-cctabs)
plugin over HTTP on `127.0.0.1:3300`. If the plugin isn't installed or isn't
running, every cctabs command fails.

Checks, in order:

1. **Is the plugin installed?**
   Tabby → **Settings → Plugins**. You should see "cctabs" in the installed
   list. If not, install it from the plugin manager (search "cctabs") or
   sideload — see
   [`tabby-plugin/README.md`](https://github.com/generativereality/cctabs/tree/main/tabby-plugin).
2. **Is Tabby actually running?** The plugin's HTTP server only runs while
   Tabby itself is open.
3. **Is the port reachable?**
   ```bash
   curl -sS http://127.0.0.1:3300/api/health
   # → {"ok":true,"version":"0.1.0"}
   ```
4. **Did you change the port?** Override on the cctabs side with
   `CCTABS_TABBY_PORT=3301 cctabs sessions` (and match the host with
   `CCTABS_TABBY_HOST=` if you bound to something other than loopback).

## Tabby: `cctabs sessions` works but the current tab isn't marked "(current)"

cctabs identifies the tab it's running in by walking its own
`process.pid → ppid → …` chain and asking the plugin which tab owns any of
those PIDs. If none match, cctabs falls back to "no current tab known".

Common causes:

- **You started the cctabs process outside any Tabby tab** (e.g. SSH'd into
  the box from elsewhere, or reattached to a tmux/screen session that pre-
  dated the current Tabby tab). The PID chain genuinely doesn't lead back to
  a Tabby-owned shell.
- **You're on a platform the plugin doesn't index PIDs on yet.** macOS and
  Linux are supported via `session.getChildProcesses()`; Windows is best-
  effort.
- **`ps -o ppid= -p <pid>` doesn't behave as expected on your shell.** Verify
  it returns just a number for your PID:
  ```bash
  ps -o ppid= -p $$
  ```

## Tabby: `cctabs new` opens a tab but the title isn't set

The plugin's `POST /api/tabs/new` returns immediately once Tabby's
`AppService.openNewTabRaw` has registered the tab — the tab's shell may
still be initializing. cctabs's `renameTab` follow-up usually wins, but if
the title flickers, increase the post-spawn delay in
`open-session.ts` or report a bug with steps to reproduce.

## Other issues

If `cctabs sessions` returns confusing data after a restart but `cctabs doctor`
reports a clean environment, see [Session Workflows → Restoring after a
restart](./workflows.md).
