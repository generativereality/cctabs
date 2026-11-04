# Reading tabs: status, identity and what a tab has said

## Workflow: Checking What's Running

Before starting new sessions, always check what's already active:

```bash
cctabs sessions
```

Output example:
```
Sessions
==================================================

Workspace: work (current)

  [a1b2c3d4] "auth" ◄  ~/Dev/myapp
    ● active (turn in flight)  ·  bypassPermissions
  [e5f6a7b8] "api"  ~/Dev/myapp
    ○ idle (waiting for input)  ·  plan
  [c9d0e1f2] "infra"  ~/Dev/myapp
      terminal
    last: $ git status
  [b3c4d5e6] "notes"  ~/Dev/myapp
    ? unreadable
    no output captured, but pid 4812 is running — open it to see
```

The four statuses mean different things and only two of them are about Claude:

| status | meaning |
|---|---|
| `● active` | a turn is in flight right now |
| `○ idle` | Claude is there, waiting for input |
| `terminal` | a shell prompt, no Claude session |
| `? unreadable` | **no output could be read for this tab** — says nothing about whether a session is running |

`unreadable` is not "dead". The Tabby plugin captures a tab's output by
subscribing to it, and a tab it never managed to subscribe to reads empty
forever while Claude runs happily inside. That is why the line underneath
reports the pid: a pid means something is running in there regardless of what
the buffer says, and `restore` will refuse to touch such a tab.

The trailing word after the status is the tab's **permission mode**, read from
Claude's own footer.

## Which tab am I in? — `cctabs whoami`

When a session needs to name itself — a PR body, a commit trailer, a status post
— use `cctabs whoami`. It prints the tab name, so `$(cctabs whoami)` works
directly. `--json` adds `worktree`, `session_id`, `cwd`, `backend` and how it
identified the tab (`via`).

- ⛔ **Never guess the tab/session name, and never match on a "focused tab"
  notion** — focus reads false for a background tab running the command, which
  silently attributes work to the wrong session.
- ⚠️ **`unknown` is a real answer, and exits 0.** A session in a plain terminal,
  over SSH or in CI has no tab: say "unnamed session" rather than inventing one.
- `via` says how the tab was found: `pid` (the terminal matched this process
  tree — exact), `session-slug` (the one tab whose directory holds this
  session's transcript), or `argv-name` (the one tab named what this Claude was
  launched with `--name`). On a `tabby-cctabs` older than 0.1.5 the `pid` route
  fails for every tab more than five minutes old — see "Restarting the fleet" in
  [references/restore-and-restart.md](restore-and-restart.md) —
  so the fallbacks are what answer there.
- Prefer it over piping `cctabs sessions --json` into a matcher: that resolves
  every tab by scanning transcripts (~7.7s on a 65-tab fleet, minutes cold),
  where `whoami` is ~1s and reads no transcripts.

## What has that tab worked out? — `cctabs transcript`

⛔ **Before you draft a message to another tab, read what it has already
said.** Briefing a session from a stale picture is how you tell a tab to go
measure two things it measured an hour ago — and miss the third thing it found
that you didn't know about.

```bash
cctabs transcript payments          # last 3 assistant messages
cctabs transcript payments 10       # last 10
cctabs transcript payments --json   # for a driver: session_id, cwd, backend, turns[]
cctabs findings payments            # same command, reads better when you're asking "what did it find?"
```

- ⚠️ **This is not `scrollback`.** `scrollback` returns the last *painted frame*,
  so a tab mid-turn shows you a spinner and nothing else — its actual findings
  are in the transcript, not on the screen. `transcript` reads the transcript.
- It searches **every Claude config dir**, not just `~/.claude/projects`. A tab
  running under a backend preset writes beneath that preset's own
  `CLAUDE_CONFIG_DIR`, and looking in one root reports "no transcript" for a
  perfectly healthy session — which reads as "that tab is dead".
- A tab **renamed after Claude started** is found anyway (0.6.3+): its running Claude is asked.
- It **exits non-zero and says which failure it is** rather than printing
  nothing: no session titled after this tab and no running Claude to ask, no
  transcript on disk, or a lookup that failed outright. "I couldn't read it" and "it hasn't said anything" are different
  answers.
- Tool-only and thinking-only messages are skipped; you get the prose.
