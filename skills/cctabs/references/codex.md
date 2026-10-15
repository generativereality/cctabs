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

**Not yet** (planned): Codex session ids in `sessions --json`, so `manifest`, `restore` and
`restart-tabby` bring Codex tabs back (today they are listed as having no session and are not
restored); `--suspended`; `--backend` (a Claude concept); Windows (the launch line does not yet
quote the prompt for cmd.exe). Until then, resume by hand with `--engine codex --resume <id>`: the
id is in the first line of `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`
(`session_meta.payload.session_id`, with its `cwd`), or use `codex resume --last` in the tab.
