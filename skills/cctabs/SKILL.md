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

### Driving a remote Tabby over SSH

cctabs can open/list/close/send tabs on **another machine's** Tabby over SSH,
as long as that machine's cctabs plugin is running. The plugin listens on
`127.0.0.1:3300`, and an SSH session on the same host reaches it fine.

The only wrinkle: over SSH the parent terminal never exports `TERM_PROGRAM`,
so cctabs can't sniff the terminal from the environment. Two ways it copes:

- **Auto-fallback (usually nothing to do):** when env detection comes up
  `unknown`, cctabs probes the Tabby plugin on `127.0.0.1:3300` and, if it
  answers, treats the session as Tabby. So a bare
  `ssh host 'cctabs new foo "~"'` just works when the remote plugin is up.
- **Explicit override:** set `CCTABS_TERMINAL=tabby` (alias `CCTABS_BACKEND`)
  to force the Tabby backend regardless of `TERM_PROGRAM` — belt-and-braces
  when you don't want to rely on the probe, or to force a specific backend.

```bash
# Open a tab on the other Mac's Tabby, from here:
ssh motin@motin-mbp21.local 'cctabs new mbp21-task "~/Dev/proj"'
# Force the backend explicitly if you prefer:
ssh motin@motin-mbp21.local 'CCTABS_TERMINAL=tabby cctabs new mbp21-task "~/Dev/proj"'
```

Tabs are still **per-machine** — each host has its own Tabby + plugin, so a tab
opened via SSH lives on the remote machine. Verify a remote host is ready with
`ssh host 'cctabs doctor'`: it reports `Terminal — tabby (via plugin probe …)`
when the fallback is in play.

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
cctabs resume <name> [dir] [-s session]  # resume last session (reuses tab or creates one)
cctabs restore [dir] [--dry]             # resume every dead tab by name search (e.g. after a reboot)
cctabs restore --manifest <file|-> [-c] [--dry]  # resume from an explicit {name,dir,session_id} list — accepts `cctabs sessions --json` directly
cctabs fork <tab-name> [-n new-name]     # fork session into new tab (--resume <id> --fork-session)
cctabs close <name-or-id>                # close a tab
cctabs rename <name-or-id> <new-name>    # rename the tab title + on-disk customTitle (so `resume` finds it); NOT the live claude/RC name — see "Two names"
cctabs scrollback <tab-or-block> [n]    # read terminal output (default: 50 lines)
cctabs send <tab-or-block> [text]        # send input — arg, --file, or stdin pipe
cctabs export <name> [--out path]        # bundle a tab + its claude session into a tarball
cctabs export --all [-w workspace]       # bundle every tab in a workspace
cctabs import <tarball> [--dry-run] [-f] # restore tabs + sessions from a tarball
cctabs backends                          # list available backend presets
cctabs config                            # show config and path
```

## Backends: running Claude Code on Ollama / Kimi / Qwen / local models — or a different Claude account

By default, `cctabs new` runs `claude` against the Anthropic API, using whatever account is logged into Claude Code's default profile. Pass `--backend <preset>` (or `-b`) to launch the tab against a different model provider (Ollama/Kimi/Qwen/local) **or a different Claude account entirely** (e.g. a separate client's or organization's subscription) — useful for cheap/free scratch sessions, privacy-sensitive work, experimenting with frontier open-weight models, or keeping a client's Claude usage cleanly separated from your own.

`cctabs` does this by prepending env vars to the `claude` command in the new tab: for model-provider presets that's `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, etc. plus `--model <name>`; for a different-account preset it's `CLAUDE_CODE_OAUTH_TOKEN` (and optionally `CLAUDE_CONFIG_DIR`) — see below.

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
- **Backend carries into child tabs.** Each launched tab's claude process gets `CCTABS_ACTIVE_BACKEND=<name>`, so a `new`/`resume`/`fork` run from *inside* that session defaults `-b` to the same preset instead of quietly falling back to `anthropic` (your default account). Explicit `-b` still wins, and `-b anthropic` forces the default back. This matters most for account-switching presets (below): a spawned sub-task tab stays on the client's account rather than billing your own.
- **`resume` prefers the account the session actually belongs to.** Sessions live under their preset's `CLAUDE_CONFIG_DIR`, so cctabs knows which account each one came from and resumes it there — ahead of any inherited backend, which would otherwise be whichever account the *calling* tab happened to run under. Precedence: explicit `-b` → the session's own account → inherited. The success line says which (`[backend: client-x (from session)]`).
- **Custom presets** can be added in `~/.config/cctabs/config.toml`. Two forms:
  ```toml
  # Different model/provider — base_url + auth_token shorthand:
  [backends.my-preset]
  model = "qwen3-coder-next:cloud"
  base_url = "http://localhost:11434"
  description = "My custom preset"

  # Fully custom env vars via env_<NAME> — use this for anything not covered
  # by the base_url shorthand, including a different Claude account:
  [backends.client-x]
  description = "Client X's Claude account"
  env_CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-..."
  env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-client-x"
  ```
  `env_<NAME>` sets any env var verbatim on the spawned `claude` process — not limited to the Ollama-oriented fields.

### Running Claude Code as a different account (e.g. a client's or org's subscription)

macOS stores Claude Code's OAuth login in the Keychain as a single global entry per macOS user (service `Claude Code-credentials`, account `<your OS username>`) — it is **not** scoped by `CLAUDE_CONFIG_DIR`. So `CLAUDE_CONFIG_DIR` alone isolates settings/history/MCP config between profiles, but **not** login — two interactive `/login` sessions under different config dirs still fight over the same Keychain slot, and the most recent login wins for both.

The fix: mint a **long-lived OAuth token** for the other account (`claude setup-token`, requires that account to have a Claude subscription) and pass it via `CLAUDE_CODE_OAUTH_TOKEN`, which Claude Code's auth precedence honors *before* falling back to the Keychain default — so a tab exporting that token runs as the other account with zero Keychain collision, concurrently with your own default-profile sessions.

One-time bootstrap (the interactive login step must be done by the account owner — an agent cannot drive OAuth):
```bash
# 1. Log into the OTHER account in an isolated profile:
export CLAUDE_CONFIG_DIR=~/.claude-client-x
claude
#   -> /login -> sign in as the other account

# 2. Still in that same shell/profile, mint the long-lived token:
claude setup-token
#   -> prints a token; this is a real credential, handle like a password

# 3. Restore YOUR OWN login in the default profile (step 1 temporarily
#    overwrote the shared Keychain slot):
unset CLAUDE_CONFIG_DIR
claude
#   -> /login -> sign in as yourself again
```
Then add the token to a preset as shown above (`env_CLAUDE_CODE_OAUTH_TOKEN`), `chmod 600 ~/.config/cctabs/config.toml` (it now holds a live credential in plaintext TOML — no dynamic Keychain lookup is supported by the preset loader), and `cctabs new <name> <dir> -b client-x` just works from then on, no further login needed.

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

The search covers **every Claude account**, not just the default one: sessions launched under a backend preset live in that preset's own `CLAUDE_CONFIG_DIR`, and restore looks there too, then relaunches each tab under the account its session came from. Nothing to pass — a mixed-account fleet restores in one command. `--dry` names the account for any tab that isn't on the default one.

### Manifest-driven restore (precise, scriptable bulk resume)

When you already know exactly which sessions to bring back — e.g. you deliberately closed a batch of tabs, or you're recreating a fleet from a snapshot — skip the by-name search and drive `restore` from an explicit manifest instead:

```bash
cctabs sessions --json > snapshot.json          # capture {name, cwd, session_id} for every live tab
cctabs restore --manifest snapshot.json --dry   # preview first
cctabs restore --manifest snapshot.json --create-missing   # spawn tabs for entries with none
```

`--manifest -` reads from stdin, so `cctabs sessions --json | cctabs restore --manifest - --create-missing` works as a one-liner. Entries for tabs that are already running are reported as "already running, skipping" — safe to re-run.

**Dedupe by `session_id` before restoring.** A manifest can contain two entries with the same name pointing at the *same* `session_id` — this happens when a crash or an earlier restart leaves a stale duplicate tab behind. `restore` does not dedupe: it will happily spawn two separate tabs racing to be the active worker for one conversation, which shows up as Remote Control "this connection is no longer the active worker for the session (code 4090)" errors. Filter the manifest to one entry per `session_id` first.

**Bulk-restore reliability limit (hard-won).** Spawning ~35+ tabs in a single `restore --manifest --create-missing` call overwhelmed Tabby's tab-creation automation in practice: only 1-2 tabs actually got their `claude --resume …` command launched, while the rest registered in Tabby (visible in `cctabs list`) but sat as empty shells indefinitely — `cctabs sessions` showed them stuck at `? unknown` status with no `cwd`. Don't trust "✔ spawned" in the restore summary as proof the process is actually running. Verify with:

```bash
ps aux | grep "claude --allow" | grep -c -- "--resume"   # should match your tab count
```

If it's low, fall back to resuming the stragglers **one at a time** — this is slow (each call can take 10-20s right after a mass-spawn while Tabby is still catching up) but reliable:

```bash
cctabs resume <name> "<dir>" -s <session_id>   # repeat per straggler; run sequentially, not concurrently
```

`cctabs resume` detects an empty/dead tab itself ("has no live shell (empty scrollback) — recreating") and relaunches into it, so this is safe to run against tabs `restore` already registered.

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

## Workflow: Remote Control status across the fleet

Claude Code's Remote Control (`/rc`, controls a session from claude.ai/code or the mobile app) is a per-process feature — cctabs doesn't manage it directly, but since it manages the tabs *running* those processes, it's the fastest way to audit or repair RC across many sessions at once.

**Check status via scrollback**, not `cctabs sessions` (which only reports terminal/claude liveness, not RC):

```bash
cctabs scrollback auth --lines 8 | grep -iE "rc active|reconnect|disconnect|jwt|401|oauth"
```

Footer/output signatures to look for:
- `/rc active` — connected, healthy.
- `/rc reconnecting` — transient, usually self-heals within seconds.
- `Remote Control disconnected · JWT refresh failed after 401`, `OAuth token refresh failed — re-authenticate`, `Transport closed: auth token expired (code 401)` — the shared Claude Code login credential (one Keychain entry, machine-wide) has expired. This affects **every** session at once, not just the one you're looking at. Fix once with `/login` in any single session — the rest reconnect automatically once the credential refreshes, no per-tab action needed.
- `Transport closed: this connection is no longer the active worker for the session (code 4090)` — two processes are both claiming the same underlying session (see the duplicate-`session_id` gotcha under manifest restore, above). Close one of the duplicates.

**Enable RC automatically for every future session** (skips the manual `/remote-control` toggle per tab): set `"remoteControlAtStartup": true` in `~/.claude/settings.json` (or scope it to a project's `.claude/settings.json`). Re-running `/remote-control` inside a session that's *already* connected is non-destructive in the CLI — it opens a status panel, it does not disconnect (that toggle-to-disconnect behavior is VS-Code-specific).

**Sweep the whole fleet in one loop:**

```bash
for t in $(cctabs sessions --json | python3 -c "import json,sys; [print(s['name']) for w in json.load(sys.stdin)['workspaces'] for s in w['sessions'] if s.get('session_id')]"); do
  err=$(cctabs scrollback "$t" --lines 6 | grep -iE "reconnect|disconnect|jwt refresh|401|oauth token")
  [ -n "$err" ] && echo "ISSUE: $t -> $err"
done
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

## Two names: the tab title vs. the claude session (RC) name

Every session actually carries **two independent names**, and it's easy to change one while assuming you changed both:

1. **Tabby/Wave tab title** — the text on the terminal tab. Set by `cctabs new`/`resume`/`fork`, and changeable with `cctabs rename`.
2. **The claude session name** — the **remote-control (RC) session name shown on claude.ai** when you control the session from the web/mobile app. It mirrors the session's **current local name**, which is *initialized* from the launch `--name` (what cctabs passes) and thereafter changed by `/rename`.

There's also a third, on-disk name that matters for lookup: the **`customTitle` recorded in the session's `.jsonl`**, which is what `cctabs resume <name>` / `restore` search by. cctabs writes it at launch via `--name`; **Claude's in-session `/rename` does NOT rewrite it** (it only relabels the live/RC session), so a session renamed *only* with `/rename` stays findable by resume under its **original** name — a known limitation.

`cctabs rename <tab> <newName>` changes the **tab title** and now **also persists `customTitle` to the session's `.jsonl`**, so `cctabs resume <newName>` finds it afterwards. It still does **not** touch the running claude session, so the claude.ai RC name is unchanged. To rename the **live** claude session (and therefore its RC name), send Claude Code's `/rename` slash command into the tab:

```bash
cctabs rename mytab new-title                 # tab title + on-disk customTitle (so `resume new-title` finds it)
cctabs send mytab "/rename new-title"          # live claude session + RC name (Claude replies "Session renamed to: …")
```

Use both together when you want the tab title, the resume-by-name lookup, and the RC name all in sync on an already-running session.

> **How the RC name behaves (validated by controlled test).** The RC name tracks the session's **current local name** — *not* the launch `--name`. Launch `--name` only sets the *initial* name; a `/rename` changes it, and the change **persists across reconnects** — both a manual `/remote-control` toggle and an automatic (network-drop) reconnect re-register under the *current local name*, so **reconnect does NOT revert to the launch name**. The one catch: `/rename` only reaches the RC list **while the session is connected**. If you `/rename` a session whose remote-control bridge is **disconnected**, the local name changes but the RC list keeps showing the last-registered name until the session **reconnects**, at which point it syncs. So a session showing a stale name in the RC list is almost always one that was renamed **while disconnected** (or never renamed) — reconnect it, or `/rename` it once it's connected (`cctabs sessions` shows which are live). The zero-fuss option is to launch prefixed in the first place via the `prefix` config below, so the name is right from the first registration and there's nothing to re-apply.

### The `prefix` config setting

When several machines share **one claude.ai remote-control session list**, sessions from different machines can collide to the same RC name and become ambiguous. Set a per-install `prefix` so this machine stamps every name it mints:

```toml
# ~/.config/cctabs/config.toml
[defaults]
prefix = "mbp18-"
```

`cctabs config` shows the current value. When set, the prefix is prepended to **both** the tab title **and** the `claude --name` (RC name) for every name **minted** by:

- `cctabs new <name>` → tab + RC name become `mbp18-<name>`
- `cctabs resume <name>` → resolves the tab/session and re-launches `--name` in prefixed space
- `cctabs fork <src> [-n <name>]` → the new fork tab + its (now explicitly named) RC session

It is **idempotent** — a name you already typed with the prefix (`mbp18-auth`) is not prefixed twice. It does **not** retro-rename existing tabs, and `restore`/`import` keep each session's already-recorded name untouched (they reattach, they don't mint).

### Recipe: prefix all *existing* tabs on this machine

Setting `prefix` only affects newly-minted names. To retro-apply a prefix (e.g. `mbp18-`) to tabs/sessions that are already live, do both renames for each tab:

```bash
# For each existing tab NAME (from `cctabs sessions`):
cctabs rename auth mbp18-auth                  # 1. tab title
cctabs send   auth "/rename mbp18-auth"        # 2. live claude session + RC name
# (send resolves by the CURRENT name, so rename the title AFTER, or send first then rename —
#  just don't rename the title and then try to `send` by the old name.)
```

Order that's safe: **`send` the `/rename` first (matches the current title), then `cctabs rename` the tab title.** Claude acknowledges each `/rename` with "Session renamed to: …". After this one-time sweep, set `prefix` in config so all *future* tabs carry it automatically.

**The `/rename` only reaches the RC list for sessions that are currently connected** (see the note above — RC tracks the current local name, and `/rename` pushes it only over a live bridge). So:
- **Connected sessions:** `/rename` updates RC and the change survives reconnects. Done.
- **Disconnected sessions** (`cctabs sessions` shows them as `terminal`/not live): `/rename` changes the local name but RC won't reflect it until the session reconnects. Either reconnect it (it then registers under the now-prefixed local name) or `cctabs resume mbp18-<name>` it to relaunch with the prefixed `--name`.

New sessions started after `prefix` is set are correct from their first RC registration and need none of this.

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
- `cctabs new` and `cctabs resume` automatically pass `--name <tab-name>` to claude, syncing the session display name with the tab title. `cctabs rename` changes the tab title and the on-disk `customTitle` (so `resume`/`restore` find the new name) but not the live session/RC name — to also rename that use `cctabs send <tab> "/rename <newName>"` (see "Two names" above)
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
