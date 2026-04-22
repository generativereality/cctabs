---
name: cctabs
description: Manage Claude Code sessions across terminal tabs (NOT browser tabs) — list running sessions, open new ones, fork, close, inspect output, and send input. Use this when working with multiple parallel Claude Code sessions in terminal tabs.
---

You are managing Claude Code sessions using the `cctabs` CLI.

**Important:** "tabs" here means **terminal tabs** (e.g. Wave Terminal tabs), NOT browser tabs. Each terminal tab runs its own Claude Code session. This skill is for managing those terminal-based Claude Code sessions — not for browser automation.

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

## Quick Reference

```bash
cctabs sessions                          # list all tabs with session status
cctabs list                              # list all workspaces, tabs, and blocks
cctabs new <name> [dir] [-w workspace] [-p "prompt"] [-f file]  # new tab + claude
cctabs resume <name> [dir]               # resume last session (reuses tab or creates one)
cctabs fork <tab-name> [-n new-name]     # fork session into new tab (--resume <id> --fork-session)
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # rename a tab
cctabs scrollback <tab-or-block> [n]    # read terminal output (default: 50 lines)
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs config                            # show config and path
```

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
    ● active
  [e5f6a7b8] "api"  ~/Dev/myapp
    ○ idle
  [c9d0e1f2] "infra"  ~/Dev/myapp
      terminal
    last: $ git status
```

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

**Preferred: pass the initial task directly to `cctabs new`** using `--prompt` or `--file`. This polls internally until Claude's `❯` prompt appears before sending — no race condition:

```bash
cctabs new payments ~/Dev/myapp --prompt "implement the billing endpoint"
cctabs new payments ~/Dev/myapp --file /tmp/task.txt
```

If you need to send a task after the fact, poll first:

```bash
cctabs new payments ~/Dev/myapp
# Poll until ❯ appears (typically 10-15s with MCP servers)
cctabs scrollback payments 5   # repeat until you see ❯
cctabs send payments --file /tmp/task.txt
cctabs send payments "yes\n"   # quick replies
```

**Do NOT call `cctabs send` immediately after `cctabs new`** — Claude is still starting up and the text will land as raw shell commands.

### Spawning gotchas (hard-won)

1. **Verify the worktree base immediately after spawn.** `--worktree` does not always branch from your current HEAD — if you have local un-pushed commits, the child session may branch from an older commit (whatever the remote tracking branch points at). Always check:
   ```bash
   cctabs new kid ~/Dev/myapp --worktree -p "..."
   # Then in the ORCHESTRATOR tab:
   git -C ~/Dev/myapp/.claude/worktrees/kid log --oneline -1
   ```
   If the base is not what you expected, abort and fix: either push your commits to the tracking branch first, or spawn without `--worktree` and let the subagent work on your branch directly.

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

## Workflow: Sending Input to a Session

```bash
cctabs send auth "yes\n"        # approve a tool call
cctabs send auth "\n"           # press enter (confirm a prompt)
cctabs send auth "/clear\n"     # send a slash command
cctabs send auth --file ~/prompts/task.txt   # send a full prompt from file
echo "do the thing" | cctabs send auth       # pipe via stdin
```

## Workflow: Worktrees

**Always point tabs at the repo root — never at a manually-created worktree directory.** Claude Code manages worktrees itself via `claude --worktree <name>`, which creates `.claude/worktrees/<name>/` inside the repo and handles branch creation and cleanup automatically.

### New isolated session (new branch, Claude manages everything)

```bash
cctabs new feature-name ~/Dev/myapp --worktree
# Equivalent to: cd ~/Dev/myapp && claude --worktree "feature-name" --name "feature-name"
# Claude creates: ~/Dev/myapp/.claude/worktrees/feature-name/
# Claude creates branch: worktree-feature-name
```

### Existing branch — ask Claude to enter the worktree mid-session

```bash
cctabs new hiring ~/Dev/myapp          # open tab at repo root
cctabs send hiring "Enter a worktree for branch z.old/new-hire-ad and ..."
# Claude will use EnterWorktree tool to set up isolation
```

### Do NOT manage git worktrees manually

```bash
# ❌ WRONG — do not create worktree dirs yourself and pass them to cctabs new
git worktree add ~/Dev/myapp-feature branch
cctabs new feature ~/Dev/myapp-feature

# ✅ RIGHT — always use repo root; let Claude Code manage the worktree
cctabs new feature ~/Dev/myapp --worktree
```

**Why:** Manually created worktree dirs placed outside the repo confuse Claude Code's session tracking, project memory lookup (`.claude/` is in the main repo), and CLAUDE.md resolution. Claude Code's built-in worktree support keeps everything co-located under `.claude/worktrees/` and handles cleanup on session exit.

**Worktree base-commit caveat:** after spawning with `--worktree`, verify the branch base matches your expectation (see "Spawning gotchas" above). If your orchestrator has local commits that haven't been pushed, the worktree may branch from the stale remote tip instead of HEAD. This bites hardest when parallel tabs need to share schema/types your orchestrator has been working on — they won't see those changes if they branched before the commits landed upstream.

## Handling `cctabs new` Timeout Errors

`cctabs new` may occasionally fail with "Timed out waiting for new terminal block". This does **NOT** mean you have too many tabs or that Wave Terminal has hit a limit.

**Possible causes** (root cause not yet confirmed):
- Wave Terminal may need to be in focus / foreground for tab creation to register
- The internal timeout may be slightly too short for the current system load
- Transient IPC timing issue between cctabs and Wave

**What to do:**
1. **Retry the same command** — it often works on the second attempt
2. If it fails again, wait a few seconds and retry once more
3. If it keeps failing, ask the user to bring Wave Terminal to the foreground and try again

**What NOT to do:**
- ❌ Do NOT assume there is a "tab limit" — there isn't one
- ❌ Do NOT close other tabs to "make room" — this destroys the user's sessions
- ❌ Do NOT suggest the user has too many tabs open

## Workflow: Cleanup

**⚠️ NEVER close tabs without explicit user approval.** Each tab may contain an active session with important context, uncommitted work, or in-progress tasks. Closing a tab is destructive and irreversible.

**Always ask first:**
> "These tabs look idle: `old-feature`, `fix-1234`. Want me to close any of them?"

Only after the user confirms:
```bash
cctabs close old-feature               # close by name (prefix match)
cctabs close e5f6a7b8                  # close by block ID prefix
```

## Tab Naming Conventions

Name tabs after the **project or task**:
- `auth` — authentication work
- `api` — API service
- `infra` — infrastructure
- `pr-1234` — specific PR work
- `auth-v2` — forked attempt

## Notes

- Tab names are matched by exact name or prefix (case-insensitive)
- Block IDs can be abbreviated to the first 8 characters
- `cctabs new` and `cctabs resume` automatically pass `--name <tab-name>` to claude, syncing the session display name with the tab title
- Configured `claude.flags` in `~/.config/cctabs/config.toml` are applied to every session
- `cctabs send` resolves tab names to their terminal block automatically

## Lesson: the common failure mode

A pattern that wastes the most tokens: an orchestrator spawns three tabs for "parallel workstreams" on the same feature, each tab diverges from the base and from each other, the orchestrator loses visibility into what each is doing, one tab misinterprets a course-correct and resets its own work, and finally the orchestrator spends hours hand-merging commits that don't apply cleanly against an intervening refactor.

The fix is upstream: before spawning, ask *"are these workstreams actually independent?"* If the answer is "mostly, but they share a common data model / schema / utility module" — they are **not** independent for cctabs purposes. Either:
- Do them sequentially in one tab (cheapest).
- Use the Agent tool for subtasks that share orchestrator state.
- Land the shared pieces first on `main`/`next`, push, then spawn tabs (each branches cleanly off the new tip and work is truly orthogonal from there).

Parallel tabs earn their keep when the work is genuinely orthogonal (separate repos, separate brand-new directories, independent features) and when you'd otherwise be idle waiting for one long-running task to finish.
