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
- `Remote Control disconnected · JWT refresh failed after 401`, `OAuth token refresh failed — re-authenticate`, `Transport closed: auth token expired (code 401)` — the shared Claude Code login credential (one Keychain entry, machine-wide) has expired. This affects **every** session at once, not just the one you're looking at. Fix once with `/login` in any single session — the rest reconnect automatically once the credential refreshes, no per-tab action needed.
- `Transport closed: this connection is no longer the active worker for the session (code 4090)` — two processes are both claiming the same underlying session (see the duplicate-`session_id` gotcha under manifest restore in [restore-and-restart.md](restore-and-restart.md)). Close one of the duplicates.

**Enable RC automatically for every future session** (skips the manual `/remote-control` toggle per tab): set `"remoteControlAtStartup": true` in `~/.claude/settings.json` (or scope it to a project's `.claude/settings.json`). Re-running `/remote-control` inside a session that's *already* connected is non-destructive in the CLI — it opens a status panel, it does not disconnect (that toggle-to-disconnect behavior is VS-Code-specific).

**Sweep the whole fleet in one loop:**

```bash
for t in $(cctabs sessions --json | python3 -c "import json,sys; [print(s['name']) for w in json.load(sys.stdin)['workspaces'] for s in w['sessions'] if s.get('session_id')]"); do
  err=$(cctabs scrollback "$t" --lines 6 | grep -iE "reconnect|disconnect|jwt refresh|401|oauth token")
  [ -n "$err" ] && echo "ISSUE: $t -> $err"
done
```
