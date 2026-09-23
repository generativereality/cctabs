# Troubleshooting `cctabs new` timeouts

> Read when `cctabs new` fails with "Timed out waiting for new terminal block" or "Shell prompt never appeared in new tab".
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Handling `cctabs new` Timeout Errors

`cctabs new` may occasionally fail with "Timed out waiting for new terminal block" (or, on Tabby, "Shell prompt never appeared in new tab"). This does **NOT** mean you have too many tabs or that the terminal has hit a limit.

**Possible causes:**
- The terminal app may need to be in focus / foreground for tab creation to register.
- The internal timeout may be slightly too short for the current system load.
- Transient IPC timing issue between cctabs and the terminal.
- **Tabby only:** the cctabs plugin must be installed and running (`curl http://127.0.0.1:3300/api/health` to verify).

**What to do:**
1. **Retry the same command** — it often works on the second attempt
2. If it fails again, wait a few seconds and retry once more
3. If it keeps failing, ask the user to bring the terminal app to the foreground and try again
4. On Tabby, also confirm the plugin is reachable (see health check above)

**What NOT to do:**
- ❌ Do NOT assume there is a "tab limit" — there isn't one
- ❌ Do NOT close other tabs to "make room" — this destroys the user's sessions
- ❌ Do NOT suggest the user has too many tabs open
