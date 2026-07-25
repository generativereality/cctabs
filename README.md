# cctabs

**Run a fleet of Claude Code sessions. From the CLI — or from Claude itself.**

CLI command: `cctabs` · Website: [cctabs.com](https://cctabs.com)

```bash
cctabs new auth ~/Dev/myapp       # new tab, claude starts
cctabs new api ~/Dev/myapp
cctabs new infra ~/Dev/myapp

cctabs sessions                   # what's running across all tabs
cctabs scrollback auth            # read what auth is doing without switching tabs
cctabs send api --file task.txt   # drop a prompt into any session
cctabs fork auth -n auth-v2       # branch a conversation, keep the original
```

No tmux. No dashboard. Your terminal tabs are the UI.

---

## The idea

When you're running multiple Claude Code sessions in parallel, you lose track fast. Which tab is working on what? Did it finish? Is it waiting for input?

cctabs solves this with a simple CLI that treats **terminal tabs as the unit of orchestration** — open them by name, read their output, send them prompts, fork them, close them. Everything stays in sync: the tab title, the Claude session name, and the working directory.

The killer feature: **Claude can run cctabs itself.** Install the skill and your Claude Code session can spawn parallel sibling sessions, monitor their output, and coordinate across them — without you switching tabs.

## Install

**As a Claude Code plugin** (recommended — installs the CLI + skill in one step):

Run these slash commands inside a [Claude Code](https://claude.ai/code) session:

```
❯ /plugin marketplace add generativereality/plugins
  ⎿  Successfully added marketplace: generativereality

❯ /plugin install cctabs@generativereality
  ⎿  ✓ Installed cctabs. Run /reload-plugins to activate.

❯ /reload-plugins
  ⎿  Reloaded: 1 plugin · 0 skills · 5 agents · 0 hooks · 0 plugin MCP servers · 0 plugin LSP servers
```

> **Note:** These are Claude Code slash commands, not shell commands. Type them at the `❯` prompt inside a Claude Code session.

**Via npm** (CLI only, no Claude Code skill):

```bash
npm install -g cctabs
```

**Skill only** (if you already have the CLI installed via npm):

```bash
mkdir -p .claude/skills/cctabs
curl -fsSL https://raw.githubusercontent.com/generativereality/cctabs/main/skills/cctabs/SKILL.md \
  -o .claude/skills/cctabs/SKILL.md
```

**Requirements:** [Wave Terminal](https://waveterm.dev) · macOS · Node.js 20+

**One-time:** Wave needs Accessibility permission — System Settings → Privacy & Security → Accessibility → Wave ✓

## Usage

```
cctabs sessions [--json]                 what's running (active/idle status)
cctabs list                              all workspaces, tabs, and blocks
cctabs new <name> [dir] [-w workspace]   open tab, start claude
cctabs new <name> [dir] -r <session-id>  open tab, resume an existing session by ID
cctabs resume <name> [dir]               resume that session (reuses its tab, or opens one)
cctabs fork <tab> [-n new-name]          fork a session into a new tab
cctabs close <tab>                       close a tab
cctabs rename <tab> <new-name>           rename a tab (+ on-disk title, so `resume` finds it)
cctabs scrollback <tab> [lines]          read terminal output (default: 50 lines)
cctabs send <tab> [text] [--wait-for-prompt]   send input — arg, --file, or stdin pipe
cctabs restore [dir] [--dry]             bring back every tab that lost its session
cctabs restore --manifest <file|-> [--create-missing]   ...or drive it from an explicit list
cctabs backends                          list backend presets (providers / Claude accounts)
cctabs config                            show config path and values
```

Tab names match by prefix. Block IDs can be shortened to 8 chars. (`resume` and
`restore` are the exception — deciding whether a session's tab already exists is
exact-name only, so a longer-named neighbour can't be mistaken for it.)

### Spin up a session fleet

```bash
cctabs sessions                 # check what's already running first

cctabs new auth ~/Dev/myapp
cctabs new payments ~/Dev/myapp
cctabs new infra ~/Dev/myapp
```

Each tab gets named, Claude's session name syncs to the tab title via `--name`.

### Send a prompt

```bash
# From a file (good for long context-heavy prompts)
cctabs send auth --file ~/prompts/task.txt

# Via stdin
echo "focus on the edge cases in the OAuth flow" | cctabs send auth

# Quick reply or approval
cctabs send auth "yes\n"
cctabs send auth "/clear\n"
```

### Check in without switching tabs

```bash
cctabs scrollback auth          # last 50 lines
cctabs scrollback auth 200      # last 200 lines
```

### Resume a specific session in a new tab

```bash
# Useful when multiple sessions share the same dir — pass the exact session ID
cctabs new auth ~/Dev/myapp -r 19aae7b4-1234-…

# Combines with --worktree to resume inside an existing worktree
cctabs new auth ~/Dev/myapp -W -r 19aae7b4-…
```

`cctabs resume <name>` is the right tool when there's only one session for a dir. Use `cctabs new ... --resume` when you need to disambiguate by session ID.

### Migrate a fleet between terminals

```bash
# On the source terminal, dump everything as a manifest
cctabs sessions --json > /tmp/fleet.json

# On the destination terminal, attach to any existing tabs and spawn the rest
cctabs restore --manifest /tmp/fleet.json --create-missing

# Or pipe directly
cctabs sessions --json | cctabs restore --manifest - --create-missing
```

### Fork a session

```bash
# Try a different approach without losing the original conversation
cctabs fork auth -n auth-v2
```

Runs `claude --resume <id> --fork-session` — new independent session, full shared context from the original.

### Target a workspace

```bash
cctabs new api ~/Dev/myapp -w work
```

## Claude Code Skill

The real unlock: install the plugin (see [Install](#install)) so **Claude Code can run cctabs itself**.

With the skill installed, Claude can:

- Check what's running before starting duplicate work (`cctabs sessions`)
- Spawn a parallel session for an independent subtask (`cctabs new payments ~/Dev/myapp`)
- Monitor siblings without interrupting them (`cctabs scrollback payments`)
- Drop a prompt into any session (`cctabs send payments --file spec.txt`)
- Fork its own session to explore an alternative approach (`cctabs fork auth`)

Claude becomes the orchestrator of its own fleet.

## Tip: pair with Claude Code Remote Control

Claude Code's [Remote Control](https://docs.anthropic.com/en/docs/claude-code/remote-control) lets you access a local session from any device — phone, tablet, browser — via `claude.ai/code`. The session still runs on your machine, with full filesystem and tool access.

Paired with cctabs, the pattern is:

1. Start a **command session** with Remote Control enabled:
   ```bash
   claude --remote-control "command"
   ```
2. From your phone or browser, connect to that session and assign work:
   > *"Spawn three sessions — auth, payments, infra — and start them on these tasks..."*
3. The command session uses `cctabs` to open tabs, send prompts, and check in on workers
4. You monitor and steer the whole fleet from your phone while the machine does the work

One remote-controlled session orchestrating a local fleet.

## Config

```toml
# ~/.config/cctabs/config.toml

[claude]
# Flags passed to every claude invocation
flags = ["--allow-dangerously-skip-permissions"]

[defaults]
# Default Wave workspace for new sessions
# workspace = ""

# Backend presets: another model provider, or another Claude account entirely.
# Launch with `cctabs new <name> [dir] -b client-x`; tabs spawned from inside
# that session inherit it. Sessions started under a preset that sets its own
# CLAUDE_CONFIG_DIR are still found by `resume`/`restore`, and come back under
# that account automatically.
[backends.client-x]
description = "Client X's Claude account"
env_CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat-..."
env_CLAUDE_CONFIG_DIR = "/Users/you/.claude-client-x"
```

## Terminal support

| Terminal | Status |
|----------|--------|
| [Wave Terminal](https://waveterm.dev) | ✅ Full support |
| [Tabby](https://tabby.sh) | ✅ Full support (requires the [`tabby-cctabs`](./tabby-plugin/) companion plugin) |
| iTerm2 | Planned |
| Ghostty | Planned |
| Warp | Planned |

Wave is supported via its unix socket RPC. Tabby is supported via a small companion plugin that exposes a localhost HTTP API the cctabs CLI talks to — install with `cctabs install-tabby-plugin`. Other terminals will follow as adapters — PRs welcome.

### Login shells on macOS

cctabs-spawned tabs default to **login shells** (`zsh -l`, `bash -l`, etc.) so PATH is initialised the same way Tabby's UI-spawned tabs are. Without `-l`, macOS's `/etc/zprofile` doesn't run, `path_helper` doesn't populate `/usr/local/bin` and `/opt/homebrew/bin` from `/etc/paths`, and brand-new tabs are missing Node, Homebrew, and anything else that lives there. Symptoms: `env: node: No such file or directory` in Claude Code's Bash tool, plugin MCP servers failing to start with ENOENT when they shell out to `npx`, and cctabs CLI itself failing inside the tab it just spawned. See [Tabby issue #2](https://github.com/Eugeny/tabby/issues/2) for the historical context. Pass an explicit `args` array (including `[]`) when calling the `/tabs` endpoint if you need a non-login shell.

## License

MIT
