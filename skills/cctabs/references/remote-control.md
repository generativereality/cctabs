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

**Enable RC automatically for every future session** (skips the manual `/remote-control` toggle per tab): set `"remoteControlAtStartup": true` in `~/.claude/settings.json` (or scope it to a project's `.claude/settings.json`). Re-running `/remote-control` inside a session that's *already* connected is non-destructive in the CLI — it opens a status panel, it does not disconnect (that toggle-to-disconnect behavior is VS-Code-specific).

**Sweep the whole fleet:** take the tabs that have a session from `cctabs sessions`, and for each one:

```bash
cctabs scrollback <tab> --lines 6 | grep -iE "reconnect|disconnect|jwt refresh|401|oauth token"
```

Any line it prints is an issue for that tab.
