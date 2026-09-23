# The trust gate: which directories are gated

> Read when deciding whether a `--prompt`/`--file` will land in a new tab's directory, and SKILL.md's pre-spawn check is not enough.
>
> Reference for the `cctabs` skill — moved out of [SKILL.md](../SKILL.md) to keep it short.

## Which directories are gated — it is NOT "is it a worktree"

Trust is recorded per path in **`${CLAUDE_CONFIG_DIR:-$HOME}/.claude.json`** as
`projects["<abs path>"].hasTrustDialogAccepted` (that default really is
`~/.claude.json`, a sibling of `~/.claude/` and not inside it). The check walks *up* from the
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
