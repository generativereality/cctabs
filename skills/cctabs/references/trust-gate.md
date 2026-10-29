# The trust gate: which directories are gated

> Read when deciding whether a `--prompt`/`--file` will land in a new tab's directory, and SKILL.md's rule (pass the brief to `cctabs new`, which answers the trust question itself) is not enough.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## The trust gate: what eats a `--prompt` before Claude ever sees it

⛔ **A tab opened where Claude Code isn't yet trusted never receives its
`--prompt` or `--file`.** Measured 2026-09-16: seven tabs spawned, five of them
`cctabs new <name> <dir> --worktree --file <brief>`. All five landed on the trust
dialog and **none** got its brief. One brief was worse than lost — it reached the
*shell* instead and started executing, npm-downloading `playwright` and
`aws-cdk-lib` before that session dropped to a bare prompt.

```
Accessing workspace: <path>
Quick safety check: Is this a project you created or one you trust? ...
Claude Code'll be able to read, edit, and execute files here.
  > No, exit
    Yes, I trust this folder
Enter to confirm   Esc to cancel
```

⚠️ **The marker starts on `No, exit`, so a bare Enter EXITS the session.** (The
options are drawn without numbers.) cctabs itself used to press exactly that
bare Enter. It now finds "Yes, I trust this folder", moves the cursor there and
confirms the move before pressing Enter, and presses nothing when it can't read
the cursor. It does so on `cctabs new … --prompt/--file/--path` (an explicitly
named directory) and when waking or restoring a session in a directory that
already has Claude sessions; everywhere else the dialog is left for a human. Since 0.5.12 it
never sends a `--prompt` while any dialog is still open (it warns and names the prompt file), and
it never answers Claude's one-time "Bypass Permissions mode" acceptance — that one is the user's. By
hand, the working keystroke is Down-then-Enter — and `cctabs send` appends the Enter itself
(it logs `sent "\u001b[B" ⏎`), so this is **one** call, never two:

```bash
printf '\033[B' | cctabs send <tab>   # ✅ Down + send's own Enter → "Yes, I trust this folder"
cctabs send <tab> --submit            # ⛔ bare Enter confirms "No, exit" and kills the tab
```

**Which directories are gated is NOT "is it a worktree".** Trust is recorded per repo root, and each `CLAUDE_CONFIG_DIR` has its own list: a `--worktree` of an already-trusted repo is not gated, a repo Claude Code has never run in is, however many trusted ancestors it has. Details and measurements: [references/trust-gate.md](trust-gate.md).

⭐ **No pre-check: the CLI does it.** Pass the brief to `cctabs new` itself
(`--prompt`, `--file` or `--path`). For the directory you named, it answers the
trust question as above and only then sends; if any dialog is still open it sends
nothing and prints the `cctabs send <tab> --path <file>` to run once you have
answered it in the tab.

A human can also pre-clear a repo once (run Claude Code in it and accept, or set
`hasTrustDialogAccepted` for that root by hand) — that is their call to make, not
a driver's, since it is the decision the dialog exists to ask.

## Which directories are gated — it is NOT "is it a worktree"

Claude Code records trust per path, in each config dir's own state (so every
backend preset keeps its own list). The check walks *up* from the
tab's directory and takes the first ancestor marked `true` — but the walk **stops
at the enclosing git repo root**, so trust never leaks in from above that root.
For a `--worktree` path, that root resolves to the **main repository**, not the
worktree directory.

| Directory | Gated? |
|---|---|
| A repo already trusted at its root | no — **including any `--worktree` of it** |
| A subdirectory of a trusted repo | no |
| A repo Claude Code has never run in | **yes**, however many trusted ancestors it has |
| Same repo, but under a different backend preset | **yes** — each `CLAUDE_CONFIG_DIR` has its own trust list |

⇒ Two measurements from 2026-09-16 that pin this down. `~/Dev` had been marked
trusted on 2026-08-28 and still did **not** trust `~/Dev/<team>/<repo>` — the walk
stopped at `<repo>`'s own root. Meanwhile a `--worktree` tab cut from an
already-trusted repo got no dialog at all. So "never use `--prompt` with
`--worktree`" would be the wrong rule; the real precondition is **"this path's
repo root is already trusted, in the config dir this tab will use"**.
