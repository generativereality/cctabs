---
title: Changelog
description: Release history for cctabs — what changed and when.
---

# Changelog

What's new in cctabs. Source of truth lives in [`CHANGELOG.md`](https://github.com/generativereality/cctabs/blob/main/CHANGELOG.md) on GitHub.

Install or update:

```sh
# Claude Code plugin (recommended)
/plugin install cctabs@generativereality

# Or as a standalone CLI
npm i -g @generativereality/cctabs
```

---

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

## 0.3.0 — 2026-05-10

*Folded into 0.3.1 — not tagged separately.*

- **Tabby Terminal support.** cctabs now works on Tabby in addition to Wave. Install the companion plugin (`tabby-cctabs` on npm; available from Tabby → Settings → Plugins) and run the CLI normally — the backend is auto-detected.
- **`cctabs doctor`** prints a diagnostic of the current backend, the running plugin, and known orphaned tab-ids — useful when Wave or Tabby state drifts out of sync.
- **`cctabs new --backend <name>`** for Ollama, Kimi, Qwen, and local-model presets. Spawns Claude Code wired to the chosen backend without per-tab env juggling.

## 0.1.3 — 2026-04-25

- **`cctabs restore` searches every Claude project directory by default** instead of only the current working directory. Restore now just works after a reboot regardless of which terminal/cwd you start it from.
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
