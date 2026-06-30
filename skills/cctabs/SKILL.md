---
name: cctabs
description: |
  Manage Claude Code sessions across terminal tabs (Wave Terminal or Tabby) — list, open, fork, close, inspect output, send input. Each terminal tab runs its own Claude Code session.

  TRIGGER when the user says any of: "open a tab", "open a new tab", "open a tab with prompt …", "open a tab and <do X>", "open a tab that <does X>", "open a new cctab" (singular alias), "spawn a tab", "a new cctabs session", "in another tab", "in a separate tab", "fork this tab", "list my tabs", "close that tab", "send to <tab>", "resume <name>" — anything that refers to a terminal tab running Claude Code. ALSO trigger for: "/cctabs", or when the user mentions Wave Terminal / Tabby tab management for Claude Code.

  The word "tab" is DECISIVE. If the user says "tab" / "cctab" / "cctabs" — even paired with a task, and even when that task sounds like background or parallel work (e.g. "open a tab with prompt 'do X asap'", "open a tab and fix Y") — they mean a real terminal tab running its own Claude Code session: CALL THIS SKILL, not the Agent tool. Handing a task to a fresh tab is the single most common use: "open a tab with prompt <task>" maps directly to `cctabs new <name> [dir] --prompt "<task>"`. A background/fork subagent (the Agent tool) is NOT a tab and must never be substituted when the user said "tab" — its output is invisible in the terminal and it cannot be attached to, resumed, watched, or driven as a session. Use the Agent tool ONLY when the user explicitly says "subagent", "background agent", "spawn an agent", "do this in parallel without a new tab", or when the work is tightly interconnected with the current session's filesystem state and must share it.

  NOT for: browser tabs (use playwright/browser-automation), tmux panes, screen sessions, or non-Claude terminals.
---

You are managing Claude Code sessions using the `cctabs` CLI.

**Important:** "tabs" here means **terminal tabs** (Wave Terminal or Tabby), NOT browser tabs. Each terminal tab runs its own Claude Code session. This skill is for managing those terminal-based Claude Code sessions — not for browser automation.

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

### Tabby users: a one-time plugin install is needed

Wave Terminal works out of the box. **Tabby additionally needs a small companion plugin** that exposes a localhost HTTP API the cctabs CLI talks to.

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

`cctabs doctor` is also available for a deliberate environment check. It adapts to whichever terminal you're running in — terminal detection runs either way; on Wave it additionally inspects Accessibility permission and scans the Wave DB for orphan tabids; on Tabby it probes the cctabs plugin's localhost health endpoint. Useful if something feels off, but **not required as a preflight** since every command fails loudly on its own.

#### Auto-install + auto-restart (recommended)

```bash
cctabs install-tabby-plugin --yes
```

What it does, in order:
1. `npm install --legacy-peer-deps --prefix <tabby-plugins-dir> tabby-cctabs`
2. Captures the current claude session id from `~/.claude/projects/<slug>/`
3. Spawns a detached background worker that quits Tabby, waits for it to die, reopens it, then opens a new tab running `claude --resume <id> --fork-session` in your current cwd.

**Other Tabby tabs in the same window get killed.** Tabby's session recovery may or may not bring them back. Use `--no-restart` to skip step 3 if the user wants control.

#### Manual install (fallback)

```bash
TABBY_PLUGINS="$HOME/Library/Application Support/tabby/plugins"
mkdir -p "$TABBY_PLUGINS"
[ -f "$TABBY_PLUGINS/package.json" ] || echo '{"private":true}' > "$TABBY_PLUGINS/package.json"
npm install --legacy-peer-deps --prefix "$TABBY_PLUGINS" tabby-cctabs
# then ask the user to quit + reopen Tabby
```

`--legacy-peer-deps` is required: the plugin's peer deps (`tabby-core`, `@angular/*`, …) live inside Tabby itself, not on npm. Tabby's GUI plugin manager handles this internally.

Linux: replace `~/Library/Application Support/tabby` with `${XDG_CONFIG_HOME:-$HOME/.config}/tabby`.
Windows: `%APPDATA%\tabby`.

#### Alternative: install via Tabby's GUI

If the user prefers, point them at Tabby → **Settings → Plugins**, search "cctabs", click install, then quit + reopen Tabby. Same end state.

Do not assume "no Wave detected → cctabs unusable" — Tabby is fully supported.

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
cctabs new <name> [dir] -b <preset>      # new tab on a non-Anthropic backend (Ollama)
cctabs resume <name> [dir]               # resume last session (reuses tab or creates one)
cctabs restore [dir] [--dry]             # resume every dead tab (e.g. after a reboot)
cctabs fork <tab-name> [-n new-name]     # fork session into new tab (--resume <id> --fork-session)
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # rename a tab
cctabs scrollback <tab-or-block> [n]    # read terminal output (default: 50 lines)
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs export <name> [--out path]        # bundle a tab + its claude session into a tarball
cctabs export --all [-w workspace]       # bundle every tab in a workspace
cctabs import <tarball> [--dry-run] [-f] # restore tabs + sessions from a tarball
cctabs backends                          # list available backend presets
cctabs config                            # show config and path
```

## Backends: running Claude Code on Ollama / Kimi / Qwen / local models

By default, `cctabs new` runs `claude` against the Anthropic API. Pass `--backend <preset>` (or `-b`) to launch the tab against a different model provider — useful for cheap/free scratch sessions, privacy-sensitive work, or experimenting with frontier open-weight models.

`cctabs` does this by prepending the right env vars (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, etc.) and `--model <name>` to the `claude` command in the new tab.

### Built-in presets

Run `cctabs backends` for the live list. Common ones:

| Preset | What it is | When to use |
|---|---|---|
| `anthropic` (default) | Anthropic API | Production / coding work where capability matters |
| `kimi` | Kimi K2.6 via Ollama Cloud (Pro tier) | Cheap frontier alternative; ~5s/turn |
| `qwen-cloud` | Qwen3 Coder Next via Ollama Cloud | Fastest Pro option (~3.8s/turn) |
| `gemma-cloud` | Gemma4 31B via Ollama Cloud | Cheap general-purpose |
| `qwen-local` | Qwen3 Coder 30B local (18GB) | Offline / private; slow on M1 |
| `qwen-next-local` | Qwen3 Coder Next Q3_K_M local (38GB) | Private + most capable local; needs `ollama create` import |
| `gpt-oss` | gpt-oss 20B local (13GB) | Private; slow; ~100s/turn for 50k system prompt |
| `llama` | Llama 3.1 8B local | Fast but garbles inside Claude Code's 50k system prompt — capability gate |
| `*-tee` | Same as above but routed through `:11500` proxy | Wire-level inspection (`ollama-tee` proxy must be running) |

### Cost × privacy framing

Two axes matter:

1. **Cost** — Anthropic Pro $20/mo or Max ($100/$200/mo); Ollama Cloud Pro $20/mo (3 concurrent, includes Kimi/Qwen Cloud); local = free but hardware-bound
2. **Privacy** — Anthropic API: Anthropic sees prompts. Ollama Cloud: Ollama sees prompts. Local: nothing leaves the laptop

Match the tier to the task:
- Sensitive prompts (client code, customer data) → `qwen-next-local` or `gpt-oss`
- Routine exploration / orchestration → `anthropic` (default)
- Cost-sensitive bulk work → `kimi` or `qwen-cloud`

### Examples

```bash
# Spin up a tab on Kimi for a side experiment
cctabs new explore-kimi ~/Dev/myapp -b kimi -p "explore alternative API designs"

# Local privacy session, slower but no data leaves the laptop
cctabs new private-refactor ~/Dev/clientwork -b qwen-next-local -W

# Compare two models on the same task in parallel
cctabs new task-anthropic ~/Dev/myapp -p "implement spec X"
cctabs new task-kimi ~/Dev/myapp -b kimi -p "implement spec X"

# Custom local Ollama tag not in built-in presets:
cctabs new x ~/Dev/myapp -b qwen-local -m my-custom-tag:latest
```

### Caveats

- **Local backends are slow on M1.** A Claude Code turn against the local 50k-token system prompt takes ~100s prefill + generation on M1 Max. Only worth it for non-time-sensitive private work.
- **Llama 3.1 8B garbles tool calls** under Claude Code's system prompt. Capability gate, not a bug.
- **Ollama Cloud Pro requires `ollama signin`** (one-time). Free tier denies cloud-tagged models.
- **Custom presets** can be added in `~/.config/cctabs/config.toml`:
  ```toml
  [backends.my-preset]
  model = "qwen3-coder-next:cloud"
  base_url = "http://localhost:11434"
  description = "My custom preset"
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

## Workflow: Restoring tabs after a reboot

After a terminal restart or computer reboot, every tab loses its Claude session and shows up with `terminal` or `unknown` status (true for both Wave and Tabby). `cctabs restore` walks every such tab, looks up its session by name across **all** Claude project directories, and re-attaches in place.

```bash
cctabs restore                    # search all projects (default)
cctabs restore --dry              # preview what would be resumed without doing it
cctabs restore ~/Dev/myapp        # restrict the search to one project dir
```

If a session was started in a different `cwd` than the tab's current directory (common after `cd`-ing inside the tab), the global search still finds it via the recorded session metadata — no need to guess the right dir.

### The "Resume from summary / full session" picker

When `claude --resume` reattaches a large or old session, Claude first shows a blocking picker:

```
❯ 1. Resume from summary (recommended)
  2. Resume full session as-is
  3. Don't ask me again
```

**Always pick option 2, "Resume full session as-is."** The point of `restore` is to bring the conversation back intact — resuming from a summary discards the live context you're restoring for. `restore` auto-advances this picker for you (it moves down once to option 2 and confirms), so you normally never see it. If you ever do drive it manually (e.g. sending keys to a tab), send **↓ then Enter** — never the bare Enter that would accept the summary, and never option 3, which permanently silences the prompt in that session's config.

## Workflow: Moving sessions across machines

Use `export` + `import` to migrate a tab (or a whole workspace) — and its underlying Claude conversation — from one machine to another, e.g. when switching laptops or sharing a debug session with a teammate.

```bash
# On source machine
cctabs export auth                                  # → ./cctabs-export-auth-<ts>.tar.gz
cctabs export auth --out ~/Downloads/auth.tar.gz
cctabs export --all                                 # every tab in the current workspace
cctabs export --all --workspace tabby

# On destination machine
cctabs import ~/Downloads/auth.tar.gz --dry-run     # preview without copying or opening tabs
cctabs import ~/Downloads/auth.tar.gz               # copy session jsonl(s) + open tab(s)
cctabs import ~/Downloads/auth.tar.gz --cwd ~/Dev/myapp   # single-tab archives only — remap the cwd
cctabs import ~/Downloads/auth.tar.gz --force       # overwrite a session id that already exists locally
```

Gotchas:

- **Target cwd must exist on the destination machine.** Each manifested tab carries the original `cwd` (e.g. `/Users/alice/Dev/myapp`). If that path doesn't exist locally, that entry is skipped with a "clone the repo, then re-run" hint. Either clone/recreate the directory first, or use `--cwd` to remap (single-tab archives only).
- **No multi-tab cwd remap.** If the source laptop had repos under a different layout (e.g. `~/Dev/Projects/foo` vs `~/Dev/foo`), `--cwd` is ignored. The workaround is to extract the tarball, edit `meta.json`, and re-tar — or split into per-tab archives and import each with `--cwd`.
- **Session IDs are preserved.** The exported session jsonl lands at `~/.claude/projects/<slug>/<sessionId>.jsonl` on the destination. Pass `--force` to overwrite a colliding session id (e.g. when re-importing an updated export).
- **Always preview multi-tab imports with `--dry-run` first.** It reports which entries would import, which would be skipped (missing cwd), and where each session jsonl would land — useful before spawning many tabs.

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

## Handling `cctabs new` Timeout Errors

`cctabs new` may occasionally fail with "Timed out waiting for new terminal block" (or, on Tabby, "Shell prompt never appeared in new tab"). This does **NOT** mean you have too many tabs or that the terminal has hit a limit.

**Possible causes:**
- The terminal app may need to be in focus / foreground for tab creation to register (true for both Wave and Tabby).
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
