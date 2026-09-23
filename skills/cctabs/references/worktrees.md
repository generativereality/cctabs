# Worktrees in detail

> Read when opening a worktree tab on an existing branch, when tempted to create a worktree by hand, or when recovering a session whose worktree directory is gone.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

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

Fix: copy the transcript (and its `subagents/` sidecar dir, if present) into the repo root's project folder before resuming:

```bash
SRC=~/.claude/projects/-Users-you-Dev-myapp--claude-worktrees-feature-name   # old worktree-cwd slug
DST=~/.claude/projects/-Users-you-Dev-myapp                                   # repo-root slug
SID=<session-id>
cp -n "$SRC/$SID.jsonl" "$DST/$SID.jsonl"
cp -Rn "$SRC/$SID/subagents" "$DST/$SID/" 2>/dev/null

cctabs resume feature-name ~/Dev/myapp -s "$SID"   # now resolves with full history intact
```

Both slugs are just the absolute path with `/` → `-`; list `~/.claude/projects/` to find the exact old one if unsure.

**This manual copy is still needed as the one-time first recovery** — before it, the session has no cwd data pointing anywhere but the dead worktree path, so nothing can infer the right target. But it only needs doing once: `restore`'s cwd resolution now tracks the *last* recorded location in a session's transcript (fixed upstream — see CHANGELOG), not the first, so once you've manually relocated a session by resuming it from the repo root, subsequent `cctabs restore` runs correctly keep resuming it there instead of regressing back to the deleted worktree path. Do NOT leave a stale worktree-slug project directory lying around after this fix — `resolveTabSession` treats *any* worktree-named project directory under `~/.claude/projects/` as a strong signal that the real worktree still exists, so a leftover stale one will shadow the correctly-relocated session again. Archive it outside `~/.claude/projects/` (e.g. `~/.claude/projects-archive/`) once you've copied what you need, not merely rename it in place — a rename that still contains the session's `customTitle` inside the file is found regardless of the directory's name.
