# Restoring, restarting and the resume picker

> Read when bringing tabs back after a reboot, restoring from a manifest, restarting the fleet onto a new Claude Code version, or facing the "Resume from summary" picker.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Workflow: Restoring tabs after a reboot

After a terminal restart or computer reboot, every tab loses its Claude session and shows up with `terminal` or `? unreadable` status. `cctabs restore` walks every such tab, looks up its session by name across **all** Claude project directories, and re-attaches in place.

A tab is only rebuilt when it has **no captured output AND no running process**. An unreadable tab whose process is alive is reported and left alone — restore can neither send `claude --resume` into it (that types into whatever is already there) nor recreate it (that closes it), so it does neither.

```bash
cctabs restore                    # search all projects (default)
cctabs restore --dry              # preview what would be resumed without doing it
cctabs restore ~/Dev/myapp        # restrict the search to one project dir
cctabs restore --suspended        # bring them back as placeholders instead — see suspended-tabs.md
```

Suspended tabs are left asleep by every restore, and by `restart` — waking one is `send`'s job.

⚠️ **Read the count at the end, and trust it — it can now fail.** After
spawning, restore re-reads the tab list, checks each new tab has a process, and
resolves its session from disk, then reports `N verified, N unconfirmed, N
failed` and **exits non-zero if anything failed**. A tab counts as verified once
a Claude whose own command line says `--resume <the id asked for>` has **stayed
running** for a few seconds — without waiting for its title to reach disk. A
Claude that appears and exits (typically printing `No conversation found`, which
means the session isn't in the account it was launched under) is a failure, not
a pass. Anything short of that is
re-checked every few seconds for up to 45s before it is called failed: under
load a healthy tab can take longer than one look to attach its process, and a
false "did not come back" invites a second restore over a tab that is fine. A tab that came back as a
*different* session than the one requested counts as failed, not restored:
`claude --resume` on an id it can't find quietly opens a fresh conversation, so
the tab looks perfect and the context is gone. `unconfirmed` is its own answer —
the tab is up but its session isn't readable yet — and those are named so you
can check them with `cctabs transcript` before briefing anything from them.

The line this replaced read "78 spawned, 0 failed" while one tab was absent
entirely and another had lost its context, because it counted spawn calls that
returned rather than tabs that worked.

If a session was started in a different `cwd` than the tab's current directory (common after `cd`-ing inside the tab), the global search still finds it via the recorded session metadata — no need to guess the right dir.

The search covers **every Claude account**, not just the default one: sessions launched under a backend preset live in that preset's own `CLAUDE_CONFIG_DIR`, and restore looks there too, then relaunches each tab under the account its session came from. Nothing to pass — a mixed-account fleet restores in one command. `--dry` names the account for any tab that isn't on the default one.

### Manifest-driven restore (precise, scriptable bulk resume)

When you already know exactly which sessions to bring back — e.g. you deliberately closed a batch of tabs, or you're recreating a fleet from a snapshot — skip the by-name search and drive `restore` from an explicit manifest instead:

```bash
cctabs sessions --json > snapshot.json          # {name, cwd, session_id, backend?, config_dir?} per live tab
cctabs restore --manifest snapshot.json --dry   # preview first
cctabs restore --manifest snapshot.json --create-missing   # spawn tabs for entries with none
```

**`session_id: null` now says why.** Every row carries `session_lookup`:
`found`, `not-found` (searched every config dir; nothing is titled after this
tab — with `sessions_in_dir` counting the transcripts that *do* exist for its
directory, so a renamed tab is distinguishable from a directory nothing has ever
run in), `no-cwd` (the tab reported no directory, so nothing was looked up), or
`lookup-failed` (the search itself threw — `session_lookup_error` has the
reason). A bare null conflated all four, and they call for opposite responses:
one is a tab to spawn fresh, the others are problems to fix before touching the
fleet.

Rows also carry `claude_pid` (the Claude running in the tab, when it could be matched) and `claude_pid_via` — `shell-pid` (exact) or `argv-name` (the only Claude launched with this tab's name).

`--manifest -` reads from stdin, so `cctabs sessions --json | cctabs restore --manifest - --create-missing` works as a one-liner. Entries for tabs that are already running are reported as "already running, skipping" — safe to re-run. `backend` / `config_dir` are emitted only for sessions belonging to a non-default Claude account, and restore infers them anyway from wherever it finds the session, so a hand-written manifest can omit them.

**Permission mode travels with the manifest.** `cctabs sessions --json` records each tab's mode as `permission_mode`, read from Claude's own footer, and restore hands it back with `claude --permission-mode <mode>` — so a tab that was in plan mode comes back in plan mode instead of in whatever the global `claude.flags` produce. The flag is appended after those flags and wins; it composes with `--allow-dangerously-skip-permissions`, which only makes bypass *available* rather than selecting it. Entries with no recorded mode fall back to the configured flags, and restore says how many did so rather than doing it silently.

Two consequences worth knowing:

- **The footer is the source, not the transcript.** The transcript's `permission-mode` entries are written at turn boundaries, not when the mode changes — cycling a session shift+tab through manual → plan → bypass leaves its recorded value untouched until the next prompt is submitted. Reading the footer is what makes a mode change with no subsequent turn survive a restore.
- **Scan mode can't capture it.** A bare `cctabs restore` rebuilds tabs whose sessions are already gone, and a tab with no session has no footer to read. Modes round-trip through `--manifest` only, which means capturing the manifest *before* you close anything.

**One session, one Claude — restore now enforces it.** Two entries with different names on the same `session_id` used to spawn two tabs racing to be the active worker for one conversation (Remote Control's "this connection is no longer the active worker for the session (code 4090)"). Restore now keys on the id as well as the name: the second entry is reported `duplicate-session` and skipped, and an entry whose session a live Claude is *already running* — its argv says `--resume <id>`, in any tab — is reported `session-live` and never spawned or typed into. The shape is easy to produce by hand: a process's `--name` is a spawn-time snapshot, so reading tab names from `ps` lists a renamed tab twice. `cctabs manifest` builds the manifest from the tab list instead and refuses a collision.

**Bulk restore is reliable — with the current plugin.** A 45-tab close-and-restore completes in under a minute with tab order preserved. This used to be the opposite: spawning ~35+ tabs in one call left most of them registered in Tabby but sitting as empty shells at `? unreadable` status, because a Tabby tab only spawns its process once its terminal frontend attaches, which only happens once the tab has been focused — and each new tab stole focus from the last. `tabby-cctabs` ≥ 0.1.3 serialises tab creation internally and doesn't answer until the process is actually running, advertising `spawn-waits-for-pty` on `/api/health`; the CLI probes for that and only then spawns in parallel. Against an older plugin it falls back to one-at-a-time with a settle gap — slower, still correct.

**If you do need to verify what's running, never use `ps aux | grep`.** It truncates long command lines, so any entry whose `--name` falls past the cutoff silently disappears and a healthy tab reads as dead. Use the tab list itself, or a full-width `ps`:

```bash
cctabs sessions                       # status per tab, straight from the terminal
ps -Aww -o command | grep -c -- "--resume"   # full command lines, not truncated
```

And don't read "every Claude without `--resume`" as "every empty tab": a tab opened fresh with `cctabs new` has no `--resume` and is perfectly healthy — including the one you're running in. The question that matters is narrower, and `cctabs restart` answers it: does every session *you restored* have a Claude launched on its id?

### Restarting the fleet — `cctabs manifest` and `cctabs restart`

To put every tab on a new Claude Code version without losing a conversation:

```bash
cctabs restart                  # the plan: which pid is stopped for which tab. Touches nothing
cctabs restart --all            # do it — every tab except the one you're in
cctabs restart --only a,b       # just these
```

It snapshots the fleet (below), saves the manifest under `~/.config/cctabs/restarts/` **before** stopping anything and prints the one-line recovery command, sends SIGTERM to each tab's Claude and waits for it to exit, runs `restore --manifest … -c`, and then **audits**: every restored session must have a live Claude launched with `--resume <its id>`. One that doesn't is a tab that looks running but came back **empty**, and it is named with the command to re-run. Exit is non-zero on any of that.

What it refuses, on purpose:

- ⛔ **Running without knowing which process is you.** It needs `CLAUDE_CODE_SESSION_ID` and a `claude` among its own ancestors, and never signals any pid in its own process tree. Run it from inside a Claude Code tab.
- ⛔ **Stopping a Claude it can't tie to a session exactly.** A pid is taken only from a process launched with `--resume <that entry's id>`, or — with `tabby-cctabs` ≥ 0.1.5 — the Claude under the tab's own shell. That second route ties the process to the *tab*, not to the session: the session still comes from the tab's title, so a Claude whose own argv resumes a *different* session is left for a human, but a plain `claude` started by hand in a tab whose title matches an older transcript would still be restarted onto that older one. A tab whose Claude was started fresh and is matched only by name is listed "restart it by hand"; a tab with no session id is left alone, since restarting it would lose its context.
- ⛔ **Starting on a bad manifest.** Any error below stops it before anything is stopped. `--drop-invalid` leaves those tabs alone and restarts the rest; with `--only`, only the named tabs' problems count.

`cctabs manifest` is the snapshot on its own — `restore --manifest` reads its output directly. Compared with `sessions --json > file` it:

- **leaves the calling session out** (by session id and pid, never by tab — `--include-self` to keep it);
- rejects **two tabs sharing a name** — restore resolves entries by name, so it would bring back neither after restart stopped both. Rename one;
- rejects a session recovered from argv (below) whose transcript is not under the tab's own directory — `--resume` run from there would not find it;
- is **keyed on session id**: two tabs resolving to one session is an error, unless a live process proves which one owns it — then the other (typically a leftover tab still titled with the session's old name) is dropped with a warning;
- **checks every directory exists** — a Claude restored into a deleted directory gets `Unknown skill` from `Skill()` and `Unable to read current working directory` from git. A deleted **worktree** is not a lost session, though: Claude Code removes worktrees on exit, and `claude --resume <id>` finds a session by id from *any* directory (measured on 2.1.280 — from the repo root, a parent dir, an unrelated dir and `~`, every turn landing in the original transcript). So an entry whose `.claude/worktrees/<name>` is gone is pointed at that worktree's own repo root automatically, with a warning — it will then work in the main checkout, not an isolated worktree, so give it a fresh worktree before it touches git. Any other missing dir is an error unless `--repoint-missing-dirs <dir>`;
- **warns, but keeps,** a session filed under a different directory than its tab's — started in a subdirectory, say, then `cd`-ed out of. Resume-by-id finds it anyway on current Claude Code;
- **checks every session id has a transcript** in some Claude config dir, since resuming one that doesn't opens a fresh conversation;
- exits non-zero and writes nothing on an error, unless `--drop-invalid`.

**Where the session ids come from.** `sessions --json` (and so `manifest`) resolves each tab's session by its title on disk. When that finds nothing it now asks the process: a live Claude launched with `--resume <id>` names its session exactly, and that recovers two measured misses — a worktree renamed after the session started (the transcript sits under the old directory's slug), and a transcript whose last title no longer matches the tab. Such rows say `session_source: "argv"`. Only the **id** is taken from argv, never the name: `--name` is whatever the tab was called when it was spawned.

⚠️ **Tabby plugin ≥ 0.1.5 gives exact process matching** (update once it is released). Tabby records each tab's pid once, two seconds after it spawns, by following single-child chains — which for a Claude tab lands on Claude's own short-lived `caffeinate` helper. On a measured 57-tab fleet 52 tabs reported a pid that no longer existed, so `whoami`'s process match and restore's "is anything running here" check were reading a dead number. 0.1.5 reports each tab's real shell pid (the `stable-pid` capability). Older plugins still work, through the argv and name fallbacks above, and say less.

To relaunch a straggler individually, `cctabs resume <name> "<dir>"` detects a genuinely empty tab itself ("has no live shell (no process, no output) — recreating") and rebuilds it; if the tab can't be read but its process is alive it refuses and tells you to look, so it's safe against a tab `restore` already registered.

### The "Resume from summary / full session" picker

When `claude --resume` reattaches a large or old session, Claude first shows a blocking picker:

```
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
```

**Always pick option 2, "Resume full session as-is."** The point of `restore` is to bring the conversation back intact — resuming from a summary discards the live context you're restoring for. `restore` auto-advances this picker for you (it moves down once to option 2 and confirms), so you normally never see it. If you ever do drive it manually (e.g. sending keys to a tab), send **↓ then Enter** — never the bare Enter that would accept the summary, and never option 3, which permanently silences the prompt in that session's config.
