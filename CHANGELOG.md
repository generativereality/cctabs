# Changelog

All notable changes to **cctabs** are listed here. The user-facing version of this
page lives at [cctabs.com/changelog](https://cctabs.com/changelog).

## Unreleased

- **Fix: `restore --manifest` now rebuilds the tab bar in manifest order.** Tab-order restoration (added in 0.4.5) only ever ran in the no-manifest name-scan path; a `restore --manifest --create-missing` spawned the missing tabs appended to the end of the bar (and, on Tabby, spawned in parallel so even their relative order was nondeterministic), never re-applying the order the manifest carried. Manifest mode now records each entry's final tab id (existing match, current tab, or freshly spawned) and calls `reorderTabs` as a separate final step after all spawns complete — the parallel spawn is left untouched. Skipped under `--dry`. (Internal: the no-manifest path's `runLegacyMode` is renamed `runNameScanMode` — it was never deprecated, just older than manifest mode.)
- **More robust `restore`/`resume` picker handling, plus the follow-up mobile-app overlay.** Under heavy load (e.g. right after a large `restore`) a tab could stay stuck on Claude's "Resume from summary / full session" picker, and cctabs knew nothing about the "Continue coding in the Claude mobile app … Enter/Esc to close" remote-control info overlay that can paint immediately after the session loads — leaving the tab on an overlay rather than a clean prompt. `confirmResumePicker` now (a) waits adaptively for the picker (patient under load, but early-exits the moment the session is demonstrably loaded without one, so the common no-picker resume no longer burns the whole window), (b) retries the confirm more times for a slow load, and (c) sweeps for the mobile-app overlay — on both the picker and direct-resume paths — and dismisses it with Esc. The send-↓-once / retry-Enter-only safety is preserved, so a retry can never land on option 3 ("Don't ask me again").
- **`cctabs rename` now persists the new name to disk so `resume` can find it.** Previously `cctabs rename` (and Claude's in-session `/rename`) only relabelled the live tab / remote-control session, never the `customTitle` recorded in the session's `.jsonl` — which is what `cctabs resume <name>` / `restore` search by. A session renamed that way became unfindable by its new name. `cctabs rename` now also appends a `custom-title` entry (the same line shape Claude writes at launch) to the resolved session's transcript, so `cctabs resume <newName>` works afterwards. Claude's own `/rename` still doesn't touch disk — that remains a documented limitation (see the "Two names" section of the skill).
- **Fix: `restore` could try to relaunch a session into a directory that no longer exists.** Session cwd was resolved from the *first* recorded location in a session's transcript, not the most recent one. That's wrong once a session's working directory has changed mid-life — most commonly: a `--worktree` tab's worktree gets deleted, and the session is later manually resumed from the repo root instead. A subsequent `cctabs restore` (plain or `--manifest`) would then try to `cd` back into the deleted worktree path, ignoring the relocation. Both `resolveTabSession` and `findSessionsByNameGlobally` now track the *last* recorded cwd, matching the existing last-wins handling for renamed sessions (`customTitle`).

## 0.4.7 — 2026-07-04

- **Drive a remote Tabby over SSH.** cctabs can now open / list / close / send tabs on **another machine's** Tabby over SSH. Over SSH the parent terminal never exports `TERM_PROGRAM`, so cctabs previously refused with "unrecognised terminal" even though the target host's cctabs plugin was running and reachable on `127.0.0.1:3300`. It now (a) auto-falls back to probing that plugin when environment detection comes up empty — so a bare `ssh host 'cctabs new foo "~"'` just works when the remote plugin is up — and (b) honours an explicit `CCTABS_TERMINAL=tabby` (alias `CCTABS_BACKEND`) override to force the backend regardless of `TERM_PROGRAM`. `cctabs doctor` reports the resolved backend and how it got there (override vs plugin probe). The probe only runs when detection is otherwise unknown, so a recognised local terminal never pays the network round-trip.
- **Per-install name prefix for new sessions.** A new `defaults.prefix` config setting (empty by default) is prepended to **both** the Tabby/Wave tab title **and** the `claude --name` for every name minted by `new`, `resume`, and `fork`. Set it to disambiguate a machine when several share one claude.ai remote-control session list, where unprefixed names otherwise collide.

## 0.4.6 — 2026-06-30

- **Fix: `cctabs new --worktree` no longer spawns at the wrong commit.** Previously cctabs delegated worktree creation to `claude --worktree <name>`, which can branch from the upstream tracking ref (or another unexpected commit) when local commits aren't pushed — silently producing a worktree at a stale base. Now cctabs runs `git worktree add` itself, explicitly anchored to the target dir's current HEAD, then launches plain `claude` inside the worktree. The success line prints the base SHA so you can verify it's what you expect. If a branch named `worktree-<name>` already exists, cctabs checks it out at its existing tip and warns when that differs from HEAD.

## 0.4.5 — 2026-06-09

- **New tabs open right after the active tab (Tabby).** `new` / `fork` / `resume` previously dropped the new tab at the far end of the bar; it now lands immediately after the tab you created it from, browser-style. (Wave keeps append behaviour.)
- **Restore rebuilds the pre-reboot tab order (Tabby).** Recreated dead tabs were appended, scrambling the original layout; restore now captures the pre-reboot order and reorders the bar to match once every tab is back. Both positioning changes need the rebuilt `tabby-cctabs` plugin to take effect — with an older plugin the CLI degrades gracefully (tabs append as before).
- **Restore now auto-advances the "Resume from summary / full session" picker.** When `claude --resume` reattaches a large or old session it shows a blocking three-way picker; previously a `restore` left every such tab stuck on it (the auto-confirm logic only ran when seeding an initial prompt, which restore doesn't). `restore` now detects the picker and selects **option 2, "Resume full session as-is"** — the whole point of restore is to bring the conversation back intact, not a lossy summary. It moves the cursor down exactly once (never risking option 3, "Don't ask me again", which would permanently silence the prompt) and retries only the confirm.
- **Restore no longer double-creates tabs that share a name.** After a reboot it's possible to have two dead tabs with the same name; restore was recreating each, spawning duplicate live tabs that both resumed the same (newest) session. Restore now keeps the first tab per name and closes the extras.

## 0.4.0 — 2026-05-16

- **`cctabs export` + `cctabs import` — move tabs and their Claude sessions between machines.** `cctabs export <tab>` (or `--all` for the whole workspace) bundles each tab's Claude conversation jsonl plus a small manifest into a `.tar.gz`. On the other machine, `cctabs import <archive>` extracts the jsonls into the local `~/.claude/projects/<target-slug>/` and opens a tab that `claude --resume`s each session. The target's Claude project slug is recomputed from the resolved target cwd, so cross-machine `$HOME` differences just work. Worktree-backed tabs (`cctabs new --worktree`) are handled correctly — export falls back to scanning `<cwd>/.claude/worktrees/*` when the direct slug lookup misses, and records the actual worktree path in the manifest so import recreates the right slug on the target.
- **`--cwd <path>`** on `import` remaps a single-tab archive to a different directory. **`--dry-run`** previews everything without copying files or spawning tabs. **`--force`** overwrites a session jsonl that's already present locally.
- Uses the system `tar` binary — no new npm deps.
- Note: jsonl contents are not rewritten on import. Absolute paths from the source machine remain in the conversation history as historical references; Claude adapts to the actual current cwd on resume.

## 0.3.2 — 2026-05-13

- **Fix: `cctabs` with no arguments crashed.** The default command (which dispatches to `sessions`) was passing a fake context shaped like `{ args: {} }` to `sessionsCommand.run`, but `sessions --json` (added in 0.3.1) reads `ctx.values.json`, so the missing `values` key threw `Cannot read properties of undefined (reading 'json')`. Regression from 0.3.1.

## 0.3.1 — 2026-05-12

- **Tabby: active-session detection now survives viewport padding and spinner redraws.** Previously, Tabby tabs in the middle of a long Claude turn were misreported as `terminal` / `unknown` because the scrollback window only sampled the last 10 rows — Claude's animated status line lives further up. The detector now scans a 200-line tail and matches against spinner labels (`Thinking`, `Composing`, `Worked for…`, etc.) and Claude's brand glyphs.
- **`cctabs new --resume <name>`** to open a tab and resume a named session in one step.
- **Manifest-driven restore.** Each tab writes a manifest under `~/.cctabs/`, so `cctabs restore` can reopen every tab and resume every Claude session after a reboot — no need to remember names.
- **`cctabs send --wait-for-prompt`** waits until the tab is at a Claude prompt before delivering input, instead of racing the previous turn.
- **`cctabs sessions --json`** for scripting.
- **Skill: sharper triggers.** The Claude Code skill now lists explicit trigger phrases ("open a new tab", "in another tab", "fork this tab"…) and disambiguates "tab" from the Agent tool, so Claude stops spawning background subagents when you asked for a real terminal tab.

## 0.3.0 — 2026-05-10 *(not tagged; folded into 0.3.1)*

- **Tabby Terminal support.** cctabs now works on Tabby in addition to Wave. Install the companion plugin (`tabby-cctabs` on npm; available from Tabby → Settings → Plugins) and run the CLI normally — the backend is auto-detected.
- **`cctabs doctor`** prints a diagnostic of the current backend, the running plugin, and known orphaned tab-ids — useful when Wave or Tabby state drifts out of sync.
- **`cctabs new --backend <name>`** for Ollama, Kimi, Qwen, and local-model presets. Spawns Claude Code wired to the chosen backend without per-tab env juggling.

## 0.1.3 — 2026-04-25

- **`cctabs restore` searches every Claude project directory by default** instead of only the current working directory. Restore now Just Works after a reboot regardless of which terminal/cwd you start it from.
- **Survive Wave restart with ephemeral workspace.** Resume keeps working across Wave restarts; the workspace state no longer becomes stale.
- **`--session` accepts prefixes**, so you can resume by partial name.

## 0.1.2 — 2026-04-22

- **Prefer exact tab-name match over prefix match** in tab resolution. Stops `cctabs send api` from accidentally hitting `api-v2`.
- **Recreate dead tabs on resume** + handle spaces in project paths.
- **Bump wsh `blocks list` timeout** so `cctabs new` no longer flakes on large Wave sessions.
- **Skill: parallel-work guidance + worktree decision guide.**

## 0.1.1 — 2026-04-10

- **Skill renamed from `herd` to `cctabs`** to match the package name everywhere.

## 0.1.0 — 2026-04-10

- Initial public release: `cctabs new`, `fork`, `close`, `send`, `sessions`, `scrollback`, `restore` for Wave Terminal.
- Claude Code skill (`cctabs`) lets Claude orchestrate its own sibling sessions.
