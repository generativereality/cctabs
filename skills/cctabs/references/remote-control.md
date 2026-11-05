# Remote Control status across the fleet

> Read when auditing or repairing Claude Code Remote Control (`/rc`) across many tabs.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Workflow: Remote Control status across the fleet

Claude Code's Remote Control (`/rc`, controls a session from claude.ai/code or the mobile app) is a per-process feature — cctabs doesn't manage it directly, but since it manages the tabs *running* those processes, it's the fastest way to audit or repair RC across many sessions at once.

**Check status via scrollback**, not `cctabs sessions` (which only reports terminal/claude liveness, not RC):

```bash
cctabs scrollback auth --lines 8 | grep -iE "rc active|reconnect|disconnect|jwt|401|oauth"
```

Footer/output signatures to look for:
- `/rc active` — connected, healthy.
- `/rc reconnecting` — transient, usually self-heals within seconds.
- `Remote Control disconnected · JWT refresh failed after 401`, `OAuth token refresh failed — re-authenticate`, `Transport closed: auth token expired (code 401)` — the Claude Code login credential (one Keychain entry per config dir) has expired. This affects **every** session on that account at once, not just the one you're looking at. Fix once with `/login` in any single session — the rest reconnect automatically once the credential refreshes, no per-tab action needed.
- `Transport closed: this connection is no longer the active worker for the session (code 4090)` — two processes are both claiming the same underlying session (see the duplicate-`session_id` gotcha under manifest restore in [restore-and-restart.md](restore-and-restart.md)). Close one of the duplicates.
- **Right name in Tabby, random `<hostname>-<adj>-<noun>` name in the claude.ai/code list**: the session was copied into another profile with the source account's Remote Control pointer still in its transcript (`profile-copy` before 0.5.10). Claude Code refused that pointer as `restored_owner_mismatch` and marked the session history-suppressed. Under that mark it never takes the RC title from the session name, and the mark is permanent. `grep -l '"cause":"restored_owner_mismatch"' <config dir>/projects/*/*.jsonl` lists the affected sessions. Fix: rename each one once in claude.ai/code. The new title lives on the server and stays on the RC session the tab reattaches to. Don't edit the suppression entries out of the transcript; Claude Code wrote them on purpose.

## The claude.ai/code list is not a liveness check

"I can't see it in the list" is the commonest RC report, and usually not an RC fault. Before
touching the session:

- **The list doesn't redraw a session that has just connected or reconnected** (a fresh
  `resume`, `restore` or `restart-tabby`) until you **scroll the list**, which makes the app
  refetch. Then it appears near the top. Confirmed by the user 2026-09-23, after this was
  diagnosed twice as something else (a per-account RC cap; background-tab throttling breaking the
  heartbeat). A 34-minute watch that day showed a just-resumed session live and controllable the
  whole time.
- **The sidebar is recency-ranked and truncated** (about 20 rows, then "Show N more") and lists
  every session on the account, including other machines signed in to it. A quiet session drops out
  of view without disconnecting.
- **To check one session for real**, open its page (the sidebar row links to
  `/code/session_…`). A live session has the message box and no offline/reconnect banner.
  Match the row by its exact title, and see the next point before concluding it is missing.
- **`claude --resume <id> --name X` did not retitle the RC entry** (Claude Code as of Aug 2026):
  the session came back under its earlier RC title, while `/rename X` sent into the session updated
  it live. `cctabs rename` sends `/rename`, so use it when the list shows an old name. Not
  re-verified on later Claude Code versions.

**Enable RC automatically for every future session** (skips the manual `/remote-control` toggle per tab): set `"remoteControlAtStartup": true` in `~/.claude/settings.json` (or scope it to a project's `.claude/settings.json`). Re-running `/remote-control` inside a session that's *already* connected is non-destructive in the CLI — it opens a status panel, it does not disconnect (that toggle-to-disconnect behavior is VS-Code-specific).

**Sweep the whole fleet:** take the tabs that have a session from `cctabs sessions`, and for each one:

```bash
cctabs scrollback <tab> --lines 6 | grep -iE "reconnect|disconnect|jwt refresh|401|oauth token"
```

Any line it prints is an issue for that tab.
