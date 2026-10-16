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
- **Status.** `cctabs list`/`sessions` read Codex's own lines: `• Working (… esc to interrupt)` is
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
it never picks the newest conversation by guesswork. Session discovery currently needs a POSIX
process table; Windows launch support does not add Windows process discovery.

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
a POSIX shell (including Git Bash); cmd.exe placeholders remain unsupported.

**Windows launch:** both Git Bash and cmd.exe use an encoded Node bootstrap so user arguments
never appear literally in a Windows shell script. It runs the npm-installed Codex JS entry
(`codex.cmd` on PATH), or a native `codex.exe` when there is no usable npm entry.

**The published 0.6.0 Windows launch paths have bugs:** cmd.exe's nested bootstrap quotes can
open an empty shell, while Git Bash can change CRLF and trailing backslashes in the prompt.
These are fixed in unreleased source. The post-release Windows 11 ARM64 harness checks the
real Tabby/shell boundary, with exact argv checks for quotes, `%`, `^`, `&`, `|`, `!`, Unicode,
mixed newlines and trailing backslashes. The patched build passed all 14 cases, real fresh
prompts in both shells, cmd resume/context, and Git Bash suspended wake/context. The live run
used npm-installed Codex; native fallback has unit coverage. Codex's Windows sandbox setup is a separate first-run
step for the operator. cctabs rechecks folder trust before pressing Enter and waits for stable
input frames, because Windows can briefly render an input box before a startup dialog.
See `scripts/windows-guest/README.md` in the repo for the harness and VM cleanup rules.

**Not yet:** `--backend` (a Claude concept), Windows process discovery, and Claude-specific
conversation operations such as `fork`. Resume a known id with `--engine codex --resume <id>`.
