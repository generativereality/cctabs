---
name: cctabs
description: |
  cctab / cctabs / terminal tabs — open, list, fork, close, watch and drive Claude Code sessions that each run in their own real Tabby terminal tab. The CLI is `cctabs` (also installed as `cctab`).

  The word "tab" is DECISIVE, and a subagent is NOT a tab. If the user says "tab" / "cctab" / "cctabs" — even paired with a task, and even when that task sounds like background or parallel work (e.g. "open a tab and fix Y asap") — they mean a real terminal tab running its own Claude Code session: CALL THIS SKILL, never the Agent tool. Most common use: "open a tab with prompt <task>" maps directly to `cctabs new <name> [dir] --prompt "<task>"`. A subagent's output is invisible in the terminal and it cannot be attached to, resumed, watched or driven. Use the Agent tool ONLY when the user explicitly says "subagent", "background agent", or "in parallel without a new tab".

  TRIGGER when the user says any of: "open a tab", "open a new tab", "open a tab with prompt …", "open a tab and <do X>", "open a tab that <does X>", "open a new cctab" (singular alias), "spawn a tab", "a new cctabs session", "in another tab", "in a separate tab", "fork this tab", "list my tabs", "close that tab", "send to <tab>", "resume <name>" — anything that refers to a terminal tab running Claude Code. ALSO trigger for: "/cctabs", or Tabby tab management for Claude Code.

  NOT for: browser tabs (use browser-automation), tmux panes, or screen sessions.
---

You are managing Claude Code sessions using the `cctabs` CLI.

**Important:** "tabs" here means **terminal tabs** (Tabby), NOT browser tabs. Each terminal tab runs its own Claude Code session. This skill is for managing those terminal-based Claude Code sessions — not for browser automation.

## Before you spawn anything: is cctabs the right tool?

cctabs is excellent for:
- **Multiple human-driven sessions** on unrelated projects (check on a deploy here, draft a blog post there, monitor a long-running task somewhere else).
- **Genuinely orthogonal parallel work** where each tab touches a disjoint file set (e.g. each tab writes to its own new directory, or each tab works on a different repo).
- **Long-running background sessions** that the user wants to check on later (builds, scrapes, benchmarks).

cctabs is the WRONG tool for:
- **Interconnected parallel work within one session.** If you're orchestrating and farming out subtasks that all modify the same evolving codebase, tabs hide each other's commits from each other. By the time they're done, you have three diverged branches that need manual merge, and any intervening change on `main`/`next` can make the merge structurally painful. **Use the Agent tool instead** — subagents share your filesystem and git state, commit in place, and surface their result back to you.
- **Sequential dependencies.** If B depends on A's commits landing, don't parallelize — run A to completion first, then B.
- **Work that touches the same files as the current orchestrator session.** Commits race, branches diverge, conflicts multiply.

A good test: *"If both tabs finish successfully, will merging their output be trivial?"* If yes, cctabs is fine. If no (or you can't tell), do it sequentially or use subagents.

## First: Ensure cctabs is available

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

On your first cctabs invocation in a session, look at the version banner cctabs prints (`(@generativereality/cctabs vX.Y.Z)`) and at any `[cctabs] OUTDATED ...` warning line in the output. If you see the warning — or if the banner version is older than the version in this skill's `plugin.json` — tell the user:

> *"Your installed cctabs is `vX.Y.Z`; the current release is `vA.B.C`. Want me to upgrade with `npm install -g @generativereality/cctabs@latest` before continuing?"*

Don't silently work around an outdated CLI: detection heuristics, command flags, and bug fixes diverge between versions, so misbehavior on the user's machine is often "binary on PATH lags behind the plugin docs you're reading." The Claude Code marketplace plugin update path only refreshes this skill — the npm-installed CLI binary is a separate channel and must be upgraded explicitly.

⚠️ **This text can itself be the stale half**: the cached skill can lag the CLI on PATH by several releases. If `cctabs <cmd> --help` disagrees with this file, trust the binary — how to check which version of this skill you are reading: [references/install.md](references/install.md).

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

> *"You're in Tabby and the cctabs plugin isn't installed. I can `cctabs install-tabby-plugin --yes` — that npm-installs the plugin AND restarts Tabby in the background, dropping you back into a forked session. Caveat: any other Tabby tabs you have open will be killed. OK?"*

On approval, run `cctabs install-tabby-plugin --yes`. Tabby quits ~2s after the command returns, reopens automatically, and spawns a new tab with your forked claude session. **Your current turn ends when Tabby quits**; the resumed claude in the new tab is where the user will continue.

If the user wants to keep their other Tabby tabs intact, run `cctabs install-tabby-plugin --no-restart` instead and tell them to quit + reopen Tabby themselves.

`cctabs doctor` is also available for a deliberate environment check: it reports the detected terminal (and how it was detected), whether a login+interactive shell can find `node`, and — on Tabby — whether the cctabs plugin answers its localhost health endpoint. Useful if something feels off, but **not required as a preflight** since every command fails loudly on its own.

What the auto-install does step by step, the manual and GUI installs, and driving a remote Tabby over SSH: [references/install.md](references/install.md).

---

Each Claude Code session runs in its own **terminal tab**. `cctabs` lets you — and other Claude Code sessions — introspect and orchestrate the full session fleet.

## When to Use Worktrees

**Use `--worktree` whenever a tab will edit code on a branch that differs from the main working tree.** This includes:
- Fixing CI on a PR (`cctabs new fix-1789 ~/Dev/myapp --worktree`)
- Working on a feature branch while the main checkout runs a dev server
- Any task where multiple tabs might checkout different branches

Without `--worktree`, all tabs share the same working directory. If two tabs checkout different branches, they stomp on each other's files — causing silent conflicts, lost changes, and broken dev servers.

**Rule of thumb:**
- **Read-only / docs / coordination** → no worktree needed (stays on current branch)
- **Editing code on a different branch** → always `--worktree`

```bash
# ❌ WRONG — two tabs checking out different branches in the same directory
cctabs new fix-auth ~/Dev/myapp --prompt "checkout PR #101 and fix lint"
cctabs new fix-api ~/Dev/myapp --prompt "checkout PR #102 and fix tests"

# ✅ RIGHT — each gets its own isolated copy
cctabs new fix-auth ~/Dev/myapp --worktree --prompt "checkout PR #101 and fix lint"
cctabs new fix-api ~/Dev/myapp --worktree --prompt "checkout PR #102 and fix tests"
```

⚠️ Both ✅ lines carry a precondition: `~/Dev/myapp` must be a repo **Claude Code
has already been trusted in**. If it isn't, the tab opens on the trust dialog, the
`--prompt` is never seen, and the spawn still reports fine — see **"The trust
gate"** immediately below.

## The trust gate: what eats a `--prompt` before Claude ever sees it

⛔ **A tab opened where Claude Code isn't yet trusted never receives its
`--prompt` or `--file`.** Measured 2026-09-16: seven tabs spawned, five of them
`cctabs new <name> <dir> --worktree --file <brief>`. All five landed on the trust
dialog and **none** got its brief. One brief was worse than lost — it reached the
*shell* instead and started executing, npm-downloading `playwright` and
`aws-cdk-lib` before that session dropped to a bare prompt.

```
Accessing workspace: <path>
Quick safety check: Is this a project you created or one you trust? ...
Claude Code'll be able to read, edit, and execute files here.
  > No, exit
    Yes, I trust this folder
Enter to confirm   Esc to cancel
```

⚠️ **The marker starts on `No, exit`, so a bare Enter EXITS the session.** The
working keystroke is Down-then-Enter — and `cctabs send` appends the Enter itself
(it logs `sent "\u001b[B" ⏎`), so this is **one** call, never two:

```bash
printf '\033[B' | cctabs send <tab>   # ✅ Down + send's own Enter → "Yes, I trust this folder"
cctabs send <tab> --submit            # ⛔ bare Enter confirms "No, exit" and kills the tab
```

**Which directories are gated is NOT "is it a worktree".** Trust is recorded per repo root, and each `CLAUDE_CONFIG_DIR` has its own list: a `--worktree` of an already-trusted repo is not gated, a repo Claude Code has never run in is, however many trusted ancestors it has. Details and measurements: [references/trust-gate.md](references/trust-gate.md).

⭐ **Check it before you spawn** — cheap, read-only, and answers the question
exactly:

```bash
root=$(git -C ~/Dev/myapp rev-parse --path-format=absolute --git-common-dir); root=${root%/.git}
python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["projects"].get(sys.argv[2],{}).get("hasTrustDialogAccepted"))' \
  "${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json" "$root"
# True -> --prompt/--file will land.   None/False -> it will not; spawn bare.
```

Anything but `True` ⇒ **spawn bare, clear the gate, then send**, so no brief is in
flight while a menu is on screen:

```bash
cctabs new fix-auth ~/Dev/myapp --worktree       # no --prompt/--file yet
cctabs scrollback fix-auth                       # confirm it IS the trust dialog
printf '\033[B' | cctabs send fix-auth           # "Yes, I trust this folder"
cctabs send fix-auth --wait-for-prompt --path /tmp/brief.txt
```

A human can also pre-clear a repo once (run Claude Code in it and accept, or set
`hasTrustDialogAccepted` for that root by hand) — that is their call to make, not
a driver's, since it is the decision the dialog exists to ask.

## Quick Reference

```bash
cctabs sessions                          # list all tabs with session status
cctabs list                              # list all workspaces, tabs, and blocks
cctabs new <name> [dir] [-w workspace] [-p "prompt"] [-f file]  # new tab + claude
cctabs new <name> [dir] --path <file>    # new tab handed a file PATH to read — same handoff as `send --path`, no short flag (`-p` is --prompt here)
cctabs new <name> [dir] -b <preset>      # new tab on another backend / Claude account
cctabs new <name> [dir] -c <colour>      # new tab, coloured (also -c on resume/fork)
cctabs resume <name> [dir] [-s session]  # resume last session (reuses tab or creates one; picks the session's own account)
cctabs restore [dir] [--dry]             # resume every empty tab by name search (e.g. after a reboot)
cctabs restore --manifest <file|-> [-c] [--dry]  # resume from an explicit {name,dir,session_id,backend?} list — accepts `cctabs sessions --json` directly
cctabs manifest [-o file] [--repoint-missing-dirs <dir>]  # snapshot the fleet as a VALIDATED manifest: one entry per session id, this session left out, dirs + transcripts checked
cctabs restart [--all | --only a,b] [--dry]      # restart Claude in every tab (new Claude Code version): snapshot → stop → restore → audit. Bare = plan only
cctabs fork <tab-name> [-n new-name]     # fork session into new tab (--resume <id> --fork-session)
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # rename the tab title + on-disk customTitle (so `resume` finds it); NOT the live claude/RC name — see references/tabs.md
cctabs color <name-or-id> <colour>       # set/clear the tab colour: blue|green|orange|purple|red|yellow|none|#rrggbb
cctabs whoami [--json]                   # which tab is THIS session in? prints the tab name, or "unknown"
cctabs sort [--dry] [--reverse]          # reorder the tab bar by session activity, newest first (Tabby only)
cctabs sort --first a,b,c [--dry]        # PIN these tabs to the front, in this order; everything else keeps its relative order
cctabs scrollback <tab-or-block> [n]    # read terminal output — the last PAINTED FRAME (default: 50 lines)
cctabs transcript <tab> [n] [--json]    # read what a tab has SAID: its last n assistant messages, from the transcript (alias: `findings`)
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs send <tab> --path <file>          # hand the tab a file PATH to read — the safe way to deliver anything large
cctabs send <tab> --file <f> --verify    # check the target's transcript for what it actually RECEIVED
cctabs send <tab> --submit               # press Enter only, submitting a prompt already parked in the box
cctabs send <tab> -- <free text>         # REQUIRED when your text contains `--` (e.g. names a flag)
cctabs export <name> [--out path]        # bundle a tab + its claude session into a tarball
cctabs export --all [-w workspace]       # bundle every tab in a workspace
cctabs import <tarball> [--dry-run] [-f] # restore tabs + sessions from a tarball
cctabs profile-copy <tab|session-id> --to <preset> [-n name] [--move] [--dry]  # copy/move a session into another Claude account
cctabs backends                          # list available backend presets
cctabs config                            # show config and path
```

## Reference files — read the one that fits, when it fits

This file holds what every invocation needs. The rest is in `references/`, and each entry says when to open it:

- [references/install.md](references/install.md) — manual or GUI plugin install, what `install-tabby-plugin` does step by step, this skill text lagging the CLI, driving a remote Tabby over SSH.
- [references/trust-gate.md](references/trust-gate.md) — exactly which directories show the trust dialog (per repo root, per config dir) and the measurements behind it.
- [references/sending.md](references/sending.md) — every `send` form, what it refuses and why, `--verify`, the `--` terminator, and what a refusal means. Read before driving a tab with anything but a short reply.
- [references/routing.md](references/routing.md) — deciding WHICH tab gets a message: resolve the owner from the branch, count what it already knows, relay what was said. Read before relaying anything across a fleet.
- [references/restore-and-restart.md](references/restore-and-restart.md) — `restore` after a reboot, manifest-driven restore, `cctabs manifest` / `cctabs restart`, and the "Resume from summary" picker.
- [references/export-import.md](references/export-import.md) — moving tabs and their conversations to another machine.
- [references/backends-and-accounts.md](references/backends-and-accounts.md) — other model providers (Ollama, Kimi, Qwen, local), another Claude account, and `profile-copy` between accounts.
- [references/tabs.md](references/tabs.md) — `sort --first`, tab colours, the tab title vs. the live session (RC) name, the `prefix` setting, naming conventions.
- [references/worktrees.md](references/worktrees.md) — worktrees on an existing branch, why not to create them by hand, recovering a session whose worktree is gone.
- [references/remote-control.md](references/remote-control.md) — auditing and repairing Remote Control (`/rc`) across the fleet.
- [references/troubleshooting.md](references/troubleshooting.md) — `cctabs new` timeouts.

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
  [references/restore-and-restart.md](references/restore-and-restart.md) —
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
- It **exits non-zero and says which failure it is** rather than printing
  nothing: no session titled after this tab (with a count of how many
  transcripts *do* exist for its directory — usually means the tab was renamed
  after Claude started), no transcript on disk, or a lookup that failed
  outright. "I couldn't read it" and "it hasn't said anything" are different
  answers.
- Tool-only and thinking-only messages are skipped; you get the prose.

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

## Workflow: Opening a Session Batch

```bash
cctabs new auth ~/Dev/myapp
cctabs new api ~/Dev/myapp
cctabs new infra ~/Dev/myapp
```

Each tab is automatically named and the claude session name is synced to the tab title.

## Workflow: Resuming a Session

`cctabs resume` finds the latest session ID for the directory and runs `claude --resume <id>`.
If the named tab still exists, it reuses it. If not, it creates a new tab.

```bash
cctabs resume auth ~/Dev/myapp       # reuses "auth" tab if it exists, otherwise creates one
cctabs resume api ~/Dev/myapp
```

**Use `cctabs resume` instead of `cctabs new` when you want to continue a previous conversation.**
`cctabs new` always starts a fresh Claude session. `cctabs resume` picks up where the last session left off.

Restoring after a reboot, from a manifest, or restarting the whole fleet onto a new Claude Code version: [references/restore-and-restart.md](references/restore-and-restart.md). Moving tabs to another machine: [references/export-import.md](references/export-import.md).

## Workflow: Forking a Session

Use `fork` when you want to explore an alternative approach without disrupting the original.
`cctabs fork` finds the latest session ID for the source tab and opens a new tab with
`claude --resume <id> --fork-session`. The source tab is not modified.

```bash
cctabs fork auth                    # creates "auth-fork" tab
cctabs fork auth -n "auth-v2"       # creates "auth-v2" tab
```

The forked session shares full conversation history up to the fork point, then diverges independently.

## Workflow: Spawning a Parallel Agent

**Before spawning, re-read "is cctabs the right tool?" above.** If the task is interconnected with your current work, use the Agent tool (subagents) instead — they share your filesystem and commits.

As a Claude Code session, you can spawn a sibling session for a **genuinely independent** parallel task:

**Preferred: pass the initial task directly to `cctabs new`** using `--prompt` or `--file`. This polls internally until Claude's `❯` prompt appears before sending, which closes the *startup* race:

```bash
cctabs new payments ~/Dev/myapp --prompt "implement the billing endpoint"
cctabs new payments ~/Dev/myapp --file /tmp/task.txt
```

⚠️ **That guarantee holds only in an already-trusted directory.** The poll cannot
see `❯` behind the trust dialog, so in an untrusted repo the brief is not
delivered at all — and has been measured reaching the *shell* instead. Check the
precondition first: see **"The trust gate"** above.

If you need to send a task after the fact, poll first — and for anything
sizeable, hand over a **path** rather than the text:

```bash
cctabs new payments ~/Dev/myapp
cctabs send payments --wait-for-prompt --path /tmp/task.txt   # waits, then hands over the path
cctabs send payments "yes\n"                                  # quick replies go inline
```

⛔ **Deliver anything large with `--path`, not `--file`.** `--file` pastes the
contents through the prompt line, and a paste can arrive as a *fraction* of
itself: a measured 6,835-byte brief landed as its last 756 bytes, beginning
mid-word, and both ends reported success. `--path` has no truncation surface at
all — only the path crosses the prompt line — so use it for briefs, specs and
diffs, and keep inline text for short replies.

⭐ **`--path` also works on `new`**, so a tab can be spawned already holding its
brief: `cctabs new <name> <dir> --path <file>`. Mind the short flags — `-p` is
`--path` on `send` but `--prompt` on `new`, so `new --path` must be spelled out.
(Before 0.5.5 `new` accepted `--path` silently and dropped it: the tab opened,
the success line printed, and the brief was never delivered. An unknown option
is now a non-zero exit on every command.)

⚠️ **The screen cannot tell you whether a big paste arrived whole** — add `--verify` for a brief that matters. Why, and everything else `send` does: [references/sending.md](references/sending.md).

**Do NOT call `cctabs send` immediately after `cctabs new`** — Claude is still starting up and the text will land as raw shell commands.

### Spawning gotchas (hard-won)

1. **Worktree base.** `cctabs new --worktree` anchors the new worktree at the target dir's current HEAD (cctabs runs `git worktree add` explicitly, not delegating to `claude --worktree`). The spawn line confirms the base SHA, e.g. `Worktree created at … (base 9d4a26d…)`. If a branch named `worktree-<name>` already exists from a prior run, the worktree is checked out at *that branch's* tip and cctabs prints a warning — verify it's what you want before sending work into the tab. To double-check after spawn:
   ```bash
   git -C ~/Dev/myapp/.claude/worktrees/kid log --oneline -1
   ```

2. **Never instruct a subagent to "rebase your branch on main/next."** Subagents interpret this liberally. A common failure mode: the subagent does `git reset --hard <remote>` and throws away its own completed commits, trying to redo the work from scratch. Instead:
   - Have the orchestrator handle rebases after the subagent is done.
   - Or send a precise patch/diff rather than a verbal rebase instruction.
   - Or tell the subagent explicitly: *"do not rebase, do not reset; make fixup commits on top of your existing branch."*

3. **Subagents won't see each other's commits.** Each tab has its own working tree. If ws-A commits a schema, ws-B cannot consume it until you merge A → main → rebase B. This is a fundamental property, not a bug. Only parallelize when this limitation doesn't matter.

4. **Don't delegate rebases or merges to subagents.** Those are orchestrator work. Subagents produce content; orchestrator integrates.

## Workflow: Monitoring Another Session

```bash
cctabs scrollback auth          # last 50 lines
cctabs scrollback auth 200      # last 200 lines
```

## Routing and sending: before you message another tab

- ⛔ **Resolve the owner from the BRANCH, not the tab's name.** If no tab maps to the owning branch, say so and send nothing. Read what the tab has already said (`cctabs transcript`) and relay what was SAID, not your conclusions. The three gates in full: [references/routing.md](references/routing.md).
- ⛔ **Text containing `--` needs the `--` terminator**: `cctabs send auth -- --verify is broken`.
- ⛔ **`nothing from the text appeared in the tab` means the tab is on a rendered menu** — don't retry with `--path` and don't drive the menu blind; `cctabs scrollback` it and escalate (the trust dialog is the one exception, above). The 1 KB busy-tab refusal means shorten the message, not `--force` it.
- All `send` forms and refusals: [references/sending.md](references/sending.md). Remote Control status across the fleet: [references/remote-control.md](references/remote-control.md).

## Worktrees: point tabs at the repo root

**Always point tabs at the repo root — never at a manually-created worktree directory.** Use `cctabs new feature ~/Dev/myapp --worktree` and let it create `~/Dev/myapp/.claude/worktrees/feature/`. Existing branches, the reasons, and recovering a session whose worktree is gone: [references/worktrees.md](references/worktrees.md).

## `cctabs new` timed out

"Timed out waiting for new terminal block" / "Shell prompt never appeared in new tab" does **NOT** mean there is a tab limit — there isn't one. Retry the same command; if it keeps failing, ask the user to bring the terminal to the foreground. ❌ Never close other tabs to "make room". Causes and steps: [references/troubleshooting.md](references/troubleshooting.md).

## Workflow: Cleanup

**⚠️ NEVER close tabs without explicit user approval.** Each tab may contain an active session with important context, uncommitted work, or in-progress tasks. Closing a tab is destructive and irreversible.

**Always ask first:**
> "These tabs look idle: `old-feature`, `fix-1234`. Want me to close any of them?"

Only after the user confirms:
```bash
cctabs close old-feature               # close by name (prefix match)
cctabs close e5f6a7b8                  # close by block ID prefix
```

## Notes

- Tab names are matched by exact name or prefix (case-insensitive)
- Block IDs can be abbreviated to the first 8 characters
- `cctabs new` and `cctabs resume` automatically pass `--name <tab-name>` to claude, syncing the session display name with the tab title. `cctabs rename` changes the tab title and the on-disk `customTitle` (so `resume`/`restore` find the new name) but not the live session/RC name — to also rename that use `cctabs send <tab> "/rename <newName>"` (see "Two names" in [references/tabs.md](references/tabs.md))
- Configured `claude.flags` in `~/.config/cctabs/config.toml` are applied to every session
- `defaults.prefix` in `~/.config/cctabs/config.toml` (empty by default) is prepended to both the tab title and the `claude --name` for every name minted by `new`/`resume`/`fork` — set it to disambiguate this machine when multiple machines share one claude.ai remote-control list
- `cctabs send` resolves tab names to their terminal block automatically

## Lesson: the common failure mode

A pattern that wastes the most tokens: an orchestrator spawns three tabs for "parallel workstreams" on the same feature, each tab diverges from the base and from each other, the orchestrator loses visibility into what each is doing, one tab misinterprets a course-correct and resets its own work, and finally the orchestrator spends hours hand-merging commits that don't apply cleanly against an intervening refactor.

The fix is upstream: before spawning, ask *"are these workstreams actually independent?"* If the answer is "mostly, but they share a common data model / schema / utility module" — they are **not** independent for cctabs purposes. Either:
- Do them sequentially in one tab (cheapest).
- Use the Agent tool for subtasks that share orchestrator state.
- Land the shared pieces first on `main`/`next`, push, then spawn tabs (each branches cleanly off the new tip and work is truly orthogonal from there).

Parallel tabs earn their keep when the work is genuinely orthogonal (separate repos, separate brand-new directories, independent features) and when you'd otherwise be idle waiting for one long-running task to finish.
