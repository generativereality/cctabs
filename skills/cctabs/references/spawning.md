# Spawning, resuming, forking and watching tabs

What the core rules in `SKILL.md` stand on: when a tab is the right tool at all,
how to hand a new tab its task, and the failures that cost the most.

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

Restoring after a reboot, from a manifest, or restarting the whole fleet onto a new Claude Code version: [references/restore-and-restart.md](restore-and-restart.md). Moving tabs to another machine: [references/export-import.md](export-import.md).

## Workflow: Forking a Session

Use `fork` when you want to explore an alternative approach without disrupting the original.
`cctabs fork` preserves the source engine: Claude uses `--resume <id> --fork-session`;
Codex uses `fork <id>` (see references/codex.md). The source tab is not modified.

```bash
cctabs fork auth                    # creates "auth-fork" tab
cctabs fork auth -n "auth-v2"       # creates "auth-v2" tab
```

The forked session shares full conversation history up to the fork point, then diverges independently.

## Workflow: Spawning a Parallel Agent

**Before spawning, re-read "is cctabs the right tool?" at the top of this file.** If the task is interconnected with your current work, use the Agent tool (subagents) instead — they share your filesystem and commits.

As a Claude Code session, you can spawn a sibling session for a **genuinely independent** parallel task:

**Preferred: pass the initial task directly to `cctabs new`** using `--prompt` or `--file`. This polls internally until Claude's `❯` prompt appears before sending, which closes the *startup* race:

```bash
cctabs new payments ~/Dev/myapp --prompt "implement the billing endpoint"
cctabs new payments ~/Dev/myapp --file /tmp/task.txt
```

⚠️ **That guarantee holds only in an already-trusted directory.** The poll cannot
see `❯` behind the trust dialog, so in an untrusted repo the brief is not
delivered at all — and has been measured reaching the *shell* instead. Check the
precondition first: see [trust-gate.md](trust-gate.md).

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

⚠️ **The screen cannot tell you whether a big paste arrived whole** — add `--verify` for a brief that matters. Why, and everything else `send` does: [references/sending.md](sending.md).

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

## Workflow: Cleanup

**⚠️ NEVER close tabs without explicit user approval.** Each tab may contain an active session with important context, uncommitted work, or in-progress tasks. Closing a tab is destructive and irreversible.

**Always ask first:**
> "These tabs look idle: `old-feature`, `fix-1234`. Want me to close any of them?"

Only after the user confirms:
```bash
cctabs close old-feature               # close by name (prefix match)
cctabs close e5f6a7b8                  # close by block ID prefix
```

## Lesson: the common failure mode

A pattern that wastes the most tokens: an orchestrator spawns three tabs for "parallel workstreams" on the same feature, each tab diverges from the base and from each other, the orchestrator loses visibility into what each is doing, one tab misinterprets a course-correct and resets its own work, and finally the orchestrator spends hours hand-merging commits that don't apply cleanly against an intervening refactor.

The fix is upstream: before spawning, ask *"are these workstreams actually independent?"* If the answer is "mostly, but they share a common data model / schema / utility module" — they are **not** independent for cctabs purposes. Either:
- Do them sequentially in one tab (cheapest), or use the Agent tool for subtasks that share orchestrator state.
- Land the shared pieces first on `main`/`next`, push, then spawn tabs (each branches cleanly off the new tip and work is truly orthogonal from there).

Parallel tabs earn their keep when the work is genuinely orthogonal (separate repos, separate brand-new directories, independent features) and when you'd otherwise be idle waiting for one long-running task to finish.
