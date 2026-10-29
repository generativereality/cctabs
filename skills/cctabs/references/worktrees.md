# Worktrees in detail

> Read when opening a worktree tab on an existing branch, when tempted to create a worktree by hand, or when recovering a session whose worktree directory is gone.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

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
`--prompt` is never seen, and the spawn still reports fine — see [trust-gate.md](trust-gate.md).

## Worktrees: point tabs at the repo root

**Always point tabs at the repo root — never at a manually-created worktree directory.** Use `cctabs new feature ~/Dev/myapp --worktree` and let it create `~/Dev/myapp/.claude/worktrees/feature/`. Existing branches, the reasons, and recovering a session whose worktree is gone: [references/worktrees.md](worktrees.md).

## Workflow: Worktrees

**Always point tabs at the repo root — never at a manually-created worktree directory.** Claude Code manages worktrees itself via `claude --worktree <name>`, which creates `.claude/worktrees/<name>/` inside the repo and handles branch creation and cleanup automatically.

### New isolated session (new branch, Claude manages everything)

```bash
cctabs new feature-name ~/Dev/myapp --worktree
# cctabs creates the worktree itself, pinned to ~/Dev/myapp's current HEAD:
#   git -C ~/Dev/myapp worktree add -b worktree-feature-name \
#     ~/Dev/myapp/.claude/worktrees/feature-name <current HEAD>
# Then opens a tab at the worktree path and runs plain `claude --name feature-name`.
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

**Worktree base commit:** cctabs anchors the new worktree at the target dir's current HEAD (it runs `git worktree add` explicitly rather than delegating to `claude --worktree`), so un-pushed local commits *are* visible to the child session. The success line prints the base SHA — confirm it matches what you expect, especially if you reuse a worktree name and see a "branch already existed" warning.

### Recovering a session after its worktree directory is gone

Claude Code keys each session transcript to the exact `cwd` it was started in — `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — not to the repo. If a worktree directory is deleted (branch merged and cleaned up, disk cleanup, `git worktree remove`) but you still want that conversation, `cctabs resume <name> <repo-root> -s <session-id>` fails with `No conversation found with session ID: …` even though the transcript still exists — it's just filed under the now-gone worktree path, not the repo root.

`cctabs resume` handles it: name the repo root and the id,

```bash
cctabs resume feature-name ~/Dev/myapp -s <session-id>
```

and when the session is filed under a worktree that no longer exists, cctabs moves it into the repo root's folder first, with its `subagents/` sidecar (a copy of only the `.jsonl` loses every subagent transcript), removes the original once no Claude is running it, and moves the dead worktree's empty folder out of `projects/`, so `restore` stops taking it for a live worktree. A session whose worktree still exists is left where it is. Find the id with `cctabs sessions` or the old tab's name.
