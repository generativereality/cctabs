# Codex tabs: OpenAI's Codex CLI instead of Claude Code

> Read when the user wants a tab running Codex (`codex`) rather than Claude, or when a tab you're
> driving is a Codex tab.
>
> Reference for the `cctabs` skill.

```bash
cctabs new <name> [dir] --engine codex                       # Codex, no first turn
cctabs new <name> [dir] --engine codex --prompt "fix the build"   # first turn runs at once
cctabs new <name> [dir] --engine codex --path /tmp/brief.md       # hand it a file to read
cctabs new <name> [dir] --engine codex --resume <codex-session-id>
cctabs new <name> [dir] --engine codex --model <model>       # passed as -m
cctabs send <name> "…"                                       # same as for a Claude tab
```

**Needs** Codex installed and signed in: `npm i -g @openai/codex` (or `brew install --cask codex`),
then `codex login`. `codex login status` says which. Signed out, the tab shows "Sign in with
ChatGPT…" and cctabs reports that it could not confirm Codex started.

**How it differs from a Claude tab:**

- **The prompt is passed to `codex` at launch**, so nothing is typed into the TUI and there is no
  paste to confirm. Codex runs it as the first turn.
- **Folder trust.** In a git folder Codex asks "Trust this folder?" first, even with a prompt on the
  command line, and holds the prompt until answered. Its default option is "Trust and continue"
  (Claude's default exits). For the folder you named, cctabs presses Enter after seeing the cursor
  there. A saved `[projects."<path>"] trust_level = "trusted"` in `~/.codex/config.toml` skips it.
- **Instructions.** Codex reads `AGENTS.md`, not `CLAUDE.md`. In a folder with a CLAUDE.md and no
  AGENTS.md, cctabs adds `-c 'project_doc_fallback_filenames=["CLAUDE.md"]'` so Codex reads it (any
  `-c` makes Codex print a harmless "without the shared background server" warning). Skills:
  Codex looks in `.agents/skills/` and `.codex/skills/`; a symlink to `.claude/skills` works.
- **Status.** `sessions` reads Codex’s current screen when available, rather than stale PTY
  redraws, using its own lines: `• Working (… esc to interrupt)` is
  busy, `Worked for 3s • 20:07` above `› Ask Codex to do anything` is idle.
- **`send`** works the same, draft protection included (Codex's placeholder is dim like Claude's;
  its input is the last `›` row). Enter is sent 350 ms after the text: Codex swallows one sent
  sooner.
- **Extra flags for every launch:** `[codex] flags = [...]` in `~/.config/cctabs/config.toml`.

**Session identity and fleet restore:** `sessions --json` reports `engine: "codex"` and the
Codex session id. With the Tabby plugin's `stable-pid` capability, cctabs finds the Codex process
under the tab's shell. `codex resume <id>` names the session exactly. For a fresh launch, cctabs
reads rollout metadata under `$CODEX_HOME/sessions` (default `~/.codex/sessions`) and accepts a
unique rollout with the process's cwd and a start time within two minutes after process start.
If multiple rollouts fit, or another tab could own the same rollout, it leaves the id unresolved;
it never picks the newest conversation by guesswork. Windows discovery reads full command lines and creation times through CIM; fresh Windows
launches use the owning tab’s cwd when the process table cannot report one.

`manifest` carries the engine, id and cwd through `restore`, `restart-tabby` and `prepare-reboot`.
As with Claude, only tabs with a resolved session are saved for a terminal restart. Restore
launches `codex resume <id>` through the Codex opener. Use a saved manifest after a terminal
restart: an empty recovered shell cannot reveal which Codex conversation used to run there.
A Codex manifest whose rollout is missing is skipped instead of starting a fresh conversation.

```bash
cctabs new <name> <dir> --engine codex --resume <id> --suspended
cctabs restore --manifest fleet.json --create-missing --suspended
cctabs wake <tab-id>     # or Enter in the placeholder, or cctabs send
```

Suspended Codex tabs retain their engine and wake with `codex resume <id>`. Placeholders need
a POSIX shell (including Git Bash), or cmd.exe with the encoded Node Codex placeholder.
Claude’s cmd.exe placeholders remain unsupported; use Git Bash for those.

**Windows launch:** both Git Bash and cmd.exe use an encoded Node bootstrap so user arguments
never appear literally in a Windows shell script. It runs the npm-installed Codex JS entry
(`codex.cmd` on PATH), or a native `codex.exe` when there is no usable npm entry.

**The published 0.6.0 Windows launch paths have bugs:** cmd.exe's nested bootstrap quotes can
open an empty shell, while Git Bash can change CRLF and trailing backslashes in the prompt.
These are fixed in 0.6.1. The post-release Windows 11 ARM64 harness checks the
real Tabby/shell boundary, with exact argv checks for quotes, `%`, `^`, `&`, `|`, `!`, Unicode,
mixed newlines and trailing backslashes. The patched build passed all 14 cases, real fresh
prompts in both shells, cmd resume/context, and Git Bash suspended wake/context. The live run
used npm-installed Codex; native fallback has unit coverage. Codex's Windows sandbox setup is a separate first-run
step for the operator. cctabs rechecks folder trust before pressing Enter and waits for stable
input frames, because Windows can briefly render an input box before a startup dialog.
See `scripts/windows-guest/README.md` in the repo for the harness and VM cleanup rules.

**Engine defaults (unreleased):** `new` inherits the nearest calling agent (Codex or Claude),
falling back to Claude in a plain shell. `--engine claude|codex` overrides this; an explicit
`--backend` selects Claude unless you explicitly request Codex (that combination errors).
`fork <tab>` follows the source tab, not the caller: Codex uses `codex fork <session-id>`,
creating an independent conversation with shared history. Unknown or ambiguous Codex IDs fail
instead of selecting a Claude transcript from the same directory. `resume <name>` recognizes
an existing Codex tab. cctabs records names and IDs in `~/.config/cctabs/codex-sessions/`, so
`rename` and closed-session `resume <name>` work too. Duplicate saved names require an explicit
`--session <id>`; a conversation already running under another tab name is not opened twice.

**Conversation tools (unreleased):** `transcript` reads Codex assistant messages, including
inherited fork history up to the fork boundary. `export`/`import` preserve the engine and bundle
required ancestor rollouts with their ordinal/byte boundaries (archive format 2; imports also
accept older Claude format 1). Missing ancestors fail rather
than exporting an apparently complete conversation. Later source-only turns are not bundled.
Import keeps an existing longer local ancestor, so importing a fork does not truncate its source.
`send --verify` and send-triggered wake verify newly recorded Codex user messages, never a
Claude transcript or an old matching message. `whoami --json` includes `engine` and the Codex session ID; `doctor --engine codex` checks the
spawned shell and sign-in. `restart` accepts Codex callers and handles a mixed fleet while
protecting the caller’s process tree. Use its dry plan before operating on a fleet.

Claude account/backend presets and `profile-copy` remain Claude-specific; a Codex target is
explicitly rejected. Codex’s own authentication stays outside exported conversation archives.
Resume a known id with `--engine codex --resume <id>` on `new` as well.
