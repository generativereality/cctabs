# What cctabs can borrow from ClaudeTTY (2026-10-29)

ClaudeTTY (https://github.com/aqilc/ClaudeTTY, read at e63f480) is a macOS terminal
(Swift, about 7,000 lines, on GhosttyKit) whose tabs run in [zmx](https://github.com/neurosnap/zmx)
sessions outside the app, with a `ct` CLI and a Claude Code plugin so Claude drives its tabs.
Same job as cctabs, from the terminal's side.

⚠️ **Licence: CC BY-NC-SA 4.0** (non-commercial, share-alike), not MIT-style. Take ideas,
never its code or text.

## 1. The skill's size — measured

"~75 tokens" is ClaudeTTY's skill **description**: the part Claude Code lists in every
session. Estimates at ~4 characters a token (no tokenizer was run):

| | ClaudeTTY `ct` | cctabs 0.7.2 | cctabs, `feat/lean-skill` |
|---|---|---|---|
| Description (every session) | 305 chars ≈ 76 tok | 1,449 chars ≈ 360 tok | unchanged |
| Body (once per session that uses it) | 2,072 chars ≈ 520 tok, 35 lines | 33,814 chars ≈ **8,450 tok**, 475 lines | 6,384 chars ≈ **1,600 tok**, 73 lines |
| References (read on demand) | none | ≈ 19,200 tok in 13 files | ≈ 26,000 tok in 16 files (the moved text) |

So the cost that mattered was the body: every session that touched cctabs carried ~8.5k
tokens for the rest of its life. The lean core is ~81% smaller. Nothing was deleted: the
incident write-ups, walkthroughs and the full command list moved into `references/`
(`spawning.md`, `reading-tabs.md` and `commands.md` are new), and the core keeps eleven
rules, each of which prevents a failure that has happened, a setup checklist, the common
commands, and a one-line index of the references.

The **description** was left at ~360 tokens on purpose: CLAUDE.md explains that it carries
the "a subagent is NOT a tab" rule and the trigger words, and that its order is the only
protection against truncation. Trimming it towards ClaudeTTY's size would cost triggering,
which was a measured failure; not worth ~280 tokens.

ClaudeTTY gets away with less partly because Claude only uses `ct` inside its own app
(`ZMX_SESSION` is set), and the app does what cctabs has to explain: the terminal and the
sessions are one program, so there is no trust gate to drive from outside, no plugin to
install, no paste that can arrive truncated.

## 2. Sleeping and restoring — what is simpler there

| | ClaudeTTY | cctabs |
|---|---|---|
| Tabs survive a quit, crash or update of the terminal | yes: each tab is a zmx session the app attaches to | no: Tabby owns the PTYs, so `restart-tabby` saves, closes, restarts and restores |
| Sleep | automatic after 20 idle minutes (frees ~500 MB per Claude) | `cctabs suspend <tab>` by hand, or `restore --suspend-older-than` |
| Wake | on focus, or when another Claude `SendMessage`s it (a hook wakes the tab and waits ≤2 min) | `send`, `wake`, `resume` or Enter in the placeholder |
| Busy / waiting / idle | from Claude Code **hooks** (SessionStart, UserPromptSubmit, PostToolUse, Stop, Notification, PermissionRequest…) writing a state file per tab | read off the screen |
| "Cache is cold" | shown on a sleeping tab whose prompt cache has expired | not shown |

Worth borrowing, cheapest first:

1. **Hook-reported state.** The plugin already installs into Claude Code; a few hooks
   writing `working`/`waiting`/`idle` per session id would give `sessions` an exact
   answer, including "waiting for you" on a permission prompt, without reading a screen
   at all. Screen reading stays the fallback (Codex, older installs). This is the biggest
   win in correctness, not just tokens.
2. **`cctabs suspend --idle-for 20m`**: suspend every tab whose last message is older than
   that. The pieces exist: `restore --suspend-older-than` already dates sessions by their
   last real message (`src/core/restore-age.ts`). A one-shot command keeps cctabs
   daemonless; anyone who wants it automatic can run it from cron/launchd.
3. **`cctabs wait <tab> idle`** as its own command (today only `send --wait-for-prompt`).
4. **Cold-cache marker** in `sessions`: idle longer than the prompt-cache TTL means the
   next turn re-reads the whole context at full price. Cheap; a hint, not a feature.
5. **Wake on `SendMessage`**: a PreToolUse hook that wakes a suspended cctabs tab when
   another session messages it, as ClaudeTTY does. Only useful once (1) exists.

Not worth borrowing: processes that outlive the terminal. That is zmx's design (a
session daemon), and with Tabby owning the PTYs it would mean putting a tmux-like layer
back under every tab, which is what cctabs exists to avoid. `restart-tabby` and
`restore --pending` are the answer for Tabby.

## 3. For the comparison page

What cctabs has that ClaudeTTY does not:

- **Your own terminal**, not a new app; macOS and **Windows 11** (ClaudeTTY: macOS 26+, Apple Silicon only).
- **Any account or model backend per tab** (`-b <preset>`, `account add`), and moving a
  conversation between accounts when one runs out of quota (`profile-copy`).
- **Codex CLI tabs** next to Claude ones.
- **Fork** a conversation into a new tab, **worktree** tabs, validated **manifests**,
  `restart` onto a new Claude Code version, **export/import** to another machine.
- MIT licence.

What ClaudeTTY has that cctabs does not: tabs that survive the terminal itself, automatic
sleep, hook-driven state, a much lighter app (68 MB idle against an Electron terminal),
and a sidebar UI built for it. Its author has turned pull requests off and calls it done.
