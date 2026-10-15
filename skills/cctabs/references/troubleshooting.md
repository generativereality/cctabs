# Troubleshooting timeouts

> Read when `cctabs new` fails with "Timed out waiting for new terminal block" or "Shell prompt never appeared in new tab", or any command fails with "the Tabby plugin did not answer within Ns".
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

## "the Tabby plugin did not answer within Ns"

Any command can stop with this. It means the plugin is installed and running but too slow to
answer: Tabby itself is overloaded. Measured on 2026-10-15 with 96 Claude tabs open, load
average 360–575, Tabby's renderer at ~600% CPU and 12.8 GB swapped: `/api/tabs` took 3.5–6s.

Before 0.5.12 cctabs gave the plugin 5s and read a timeout as an **empty tab list**. `manifest`
wrote 0 entries and printed ✔, `close <id>` said the tab didn't exist, and the close-wait could
report a live tab as closed. Now every plugin call waits up to 30s and is retried once on a
timeout, and a call that still fails stops the command instead of answering "nothing there".

**What to do:**
1. Check the load: `uptime`, and Tabby's CPU (`ps -Ao pcpu,comm -r | head`).
2. Retry with a longer limit for this command: `CCTABS_TABBY_TIMEOUT=90 cctabs <command>`.
3. Tell the user the machine is overloaded, with the numbers. Closing tabs is theirs to decide —
   save a manifest first (`cctabs manifest -o …`, and **check its entry count**).

**What NOT to do:**
- ❌ Do NOT treat a result from a run that hit this as complete. A tab list, a manifest or a
  session list read during the overload is only trustworthy once its count matches what
  `curl -s 127.0.0.1:3300/api/tabs` reports.
