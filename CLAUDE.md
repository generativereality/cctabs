# cctabs

Claude Code tab manager. Terminal tabs as the UI, no tmux.

## Two packages ship from this repo

| Package | Source | Released by |
|---|---|---|
| `@generativereality/cctabs` | `src/` | the CLI. `release.yml`, on a `v*` tag. |
| `tabby-cctabs` | `tabby-plugin/` | the Tabby-side plugin. `release-tabby-plugin.yml`, on a `tabby-v*` tag. |

Both publish from CI with no token — trusted publishing, each gated on the `release`
environment. (Local tokens used to matter and the trap is worth remembering if you
ever publish by hand: `tabby-cctabs` is **unscoped**, so a token scoped to
`@generativereality` 403s on it.)

They version independently and are published separately. A CLI release does
not require a plugin release — the CLI feature-detects what the plugin can do
(see **Plugin capabilities**) and degrades rather than breaking.

## Release flow

**Publishing is CI's job. Never `npm publish` by hand** — `.github/workflows/release.yml`
publishes via npm **OIDC trusted publishing**, so there is no token to hold, and the
job is gated on the `release` environment. That gate is the whole release control:
pushing a tag *queues* a publish, it does not perform one. (It exists because on
2026-08-22 three versions went out inside forty minutes with nobody approving them
— tagging was the only control, and anything that could push a tag could publish.)

1. Make changes in `src/` and/or `skills/`
2. Bump the version in **both** `package.json` and `.claude-plugin/plugin.json` — the
   second is what `sync-plugin.sh` copies to the marketplace, and `prepack`'s sync
   check fails the publish if it lags
3. Fold `CHANGELOG.md`'s `## Unreleased` into a dated `## <version> — <date>` section
4. Run `npm run sync-plugin` — pushes plugin.json + SKILL.md to `../plugins`
5. Commit and push **this repo first**, then `git tag -a v<version>` and push the tag —
   push main before the tag, or the run publishes a commit that isn't on main yet.
   The workflow verifies the tag matches `package.json`
6. **Approve the run** in the Actions UI. Until someone does, it sits at `waiting` and
   nothing is published — a queued run is not a release
7. Users update via Claude Code: `/plugins` → Marketplaces → Update generativereality
   → update cctabs plugin

### Don't leave gaps in the npm version sequence

A tag can be cut and its run never approved — that has happened, and the tag then sits
pointing at a commit that later work lands on top of. Approving it afterwards publishes
the *old* tree under the new number.

When a version was tagged but **never published**, re-point that tag rather than burning
the number:

```bash
npm view @generativereality/cctabs versions   # confirm the version really isn't there
gh run cancel <waiting-run-id>                # the stale queued run, so nobody approves it later
git tag -f -a v<version> -m "…" <new-sha> && git push -f origin v<version>
```

Safe only while npm has never seen the version — nothing is being rewritten under anyone.
Once it is published, the number is spent: bump instead. Force-pushing a tag re-fires the
workflow, so a fresh run appears for approval.

**Note:** Claude Code only discovers skills from directory-sourced plugins in the marketplace repo (npm source doesn't support skill discovery). The `sync-plugin` script keeps `generativereality/plugins` in sync. Requires the plugins repo checked out at `../plugins`.

### A conflict in `../plugins` is resolved by RESETTING, never by merging

`npm run sync-plugin` pushes to `generativereality/plugins`. When that clone has
drifted — a sync commit made here that was never pushed, while another machine
pushed its own — the push is rejected and `git pull --rebase` conflicts in
`SKILL.md` and `plugin.json`.

**Do not resolve those conflicts.** Both sides are *generated copies* of files
that live here; hand-merging them invents a third version matching neither
source. The marketplace copy has no independent content to preserve, so:

```bash
cd ../plugins
git rebase --abort                 # if a rebase is in progress
git log --oneline origin/main..HEAD   # confirm the only local commits are `chore: sync …`
git reset --hard origin/main
cd - && npm run sync-plugin        # regenerates from source and pushes
```

Then verify rather than assume — `bash scripts/sync-plugin.sh --check`, and
`diff -q skills/cctabs/SKILL.md ../plugins/plugins/cctabs/skills/cctabs/SKILL.md`.

Check that `origin/main..HEAD` line before resetting: it is what makes this safe.
A local commit that is *not* a sync — an edit made directly in the marketplace
repo — would be destroyed, and the reset is the wrong tool for that case.

⚠️ Hit on 2026-09-22 cutting 0.5.5. The cause is worth stating precisely, because
it is the ordinary case rather than a mishap: **nothing was wrong on either side.**
The other machine synced 0.5.4 and pushed it; this clone had simply not pulled
since, and `sync-plugin` committed 0.5.5 on top of a stale `main`. The script does
not pull first, so any clone that is one release behind diverges the moment it
syncs — no unpushed work and no mistake required.

⇒ So the cheap prevention is `git -C ../plugins pull --ff-only` before a release,
and the conflict above is what you get for skipping it.

See also `generativereality/plugins`'s own README, which covers the *other*
marketplace failure: `~/.claude/plugins/marketplaces/<name>` is a git clone and
`marketplace update` is a pull, so a force-push to that repo leaves every existing
clone unreconcilable. That one is about consumers of the marketplace; this section
is about publishing to it.

### Releasing the Tabby plugin

Only needed when `tabby-plugin/src/` changed. Its version is independent of the
CLI's, and **npm forbids republishing a version**, so if the currently published
version already exists with different contents, bump — don't reuse it.

**Publishing is CI's job now** — `.github/workflows/release-tabby-plugin.yml`, triggered by a
`tabby-v*` tag and gated on the `release` environment, same as the CLI. Bump
`tabby-plugin/package.json`, push `tabby-v<version>`, approve the run. No token anywhere.

The no-gaps rule above applies here too: a `tabby-v*` tag whose run was never
approved should be re-pointed, not abandoned for the next number.

To build locally (for `sideload`, or to check a change before tagging):

```bash
# once: Tabby at this exact path, at the ref CI pins (TABBY_REF in the workflow)
git clone --depth 1 --branch v1.0.235 https://github.com/Eugeny/tabby.git related-repos/tabby
cd related-repos/tabby && yarn install && npm run build:typings && cd -

cd tabby-plugin
npm install --legacy-peer-deps                     # peers come from Tabby; only `uuid` installs
../related-repos/tabby/node_modules/.bin/webpack   # `npm run build` alone fails: webpack isn't a local dep
npm run sideload                                   # copy into Tabby's plugins dir for local testing
```

Three things that each cost a failed build to discover, so they are worth stating plainly:

- **Tabby must live at `related-repos/tabby` exactly.** `webpack.config.mjs` advertises a
  `TABBY_REPO` override, but `tsconfig.json` hardcodes `../../related-repos/tabby/...` in its
  `paths`. Setting TABBY_REPO moves webpack's resolution and leaves TypeScript's behind, and you
  get `Cannot find module '@angular/core'` from a webpack run that is otherwise fine.
- **`npm run build:typings` in Tabby is not optional.** Its workspace packages point `types` at
  `typings/index.d.ts`, absent from a fresh clone. Skip it and the build fails on `Cannot find
  module 'tabby-core'` — *after* the Angular errors clear, so it reads as a new problem.
- **`--legacy-peer-deps` is required.** The plugin's peers are all `"*"`, so npm resolves each
  independently, lands on conflicting Angular majors (seen: 20.1.8 vs 22.1.3) and fails ERESOLVE.
  Those peers are webpack `externals`, supplied by Tabby at runtime.

- `dist/` is gitignored, and CI builds it from source — so a stale local `dist/` can no longer be
  published by accident, which was the old failure mode. The workflow also refuses to publish an
  empty bundle, since `files` ships `dist/` alone and npm would happily accept nothing.
- Keep `PLUGIN_VERSION` in `tabby-plugin/src/server.ts` in step with `tabby-plugin/package.json` — it's what `/api/health` reports. It has now drifted twice: once a release behind, once a release *ahead* (a renumbered release caught `package.json` and missed the constant). Neither broke anything, because capabilities are feature-detected rather than version-compared — which is exactly why both survived review. Guarded now by `src/core/plugin-version.test.ts` and, because the plugin's release workflow never runs the test suite, by that workflow's own pre-publish check.
  The 0.1.4 tarball on npm announces itself as `0.1.5` (its bundle was built a release ahead).
  0.1.5 — the `stable-pid` release — makes that string true, and source and `package.json` both
  say 0.1.5 now.
- **Six commits on `main` carry a work-identity author address** instead of the canonical
  `Motin <motin@motin.eu>` (110 commits). The address is not repeated here: this file is public
  too, and there is no reason to add another plaintext copy of it. Nothing new is being added:
  squash-merges land as `motin@motin.eu`. Removing the existing six means rewriting history and
  force-pushing, which last time left a second machine's marketplace clone diverged and needing
  manual realignment. Open decision, not urgent.
- Sideloading only changes files on disk; **Tabby must be restarted/reloaded** to run the new plugin.

### Before releasing, check the docs that ship

`skills/cctabs/SKILL.md` is synced to the marketplace **and** included in the npm
tarball, so a stale claim in it reaches every user. It has twice described
behavior that had already been inverted by an unreleased commit. Re-read the
sections your change touches.

### The skill's `description` has a hard 1535-character budget

Claude Code truncates a skill description at **1535 characters** in the
available-skills listing and appends `…`. There is no warning: the skill still
loads and still works when invoked by name, so the loss is invisible unless you
go read a transcript's `skill_listing` attachment. Ours silently overran for
several releases and the amputated tail was the anti-substitution rule — the one
thing the description exists to say.

Rules for editing it:

- **Keep it under ~1450** so there is headroom, and re-measure after any edit.
- **Put the load-bearing sentences first.** Order is the only truncation
  protection there is. The TRIGGER list is long but individually cheap to lose a
  tail of; the "a subagent is NOT a tab" rule is not, so it goes above it.
- **Lead with the literal words a user would type** (`cctab`, `cctabs`, `tab`).
  In a project with dozens of its own skills this entry can land 75% of the way
  down 80+ entries, and the first clause is what registers.

Note what this can and cannot fix: the full listing is injected **once per
session** and is **not re-injected after a compaction** — only single-skill
recall deltas are. A long session that has compacted has no listing at all, and
no description wording reaches it. That is why `cctab` exists as a real bin
alias: probing the shell is the only discovery path left in that state.

## Plugin capabilities

`/api/health` returns `{ok, version, capabilities: [...]}`. The CLI probes it via
`TerminalAdapter.backendCapabilities()` and adapts, because a user's installed
plugin is routinely older than the CLI talking to it. Add behavior that depends
on a plugin fix as a **new capability token**, never as a version comparison.

- `tab-color` — tabs carry a colour: reported on `/api/tabs`, accepted by `POST /api/tabs/new`, and settable via `PUT /api/tabs/:uuid/color`. `--color` and `cctabs color` probe for this and degrade with one warning, because an older plugin drops the unknown `color` field silently — indistinguishable from a colour that was applied and didn't render.

  The colour is assigned straight to `BaseTabComponent.color`, which is literally what Tabby's own right-click → Color menu does (`tabby-core/src/tabContextMenu.ts`), so a cctabs-set colour is indistinguishable from a hand-set one. `src/core/colors.ts` mirrors Tabby's `TAB_COLORS` **hex values**, not just its names: that menu ticks its radio by comparing `tab.color === color.value`, so a different blue would colour the tab and still leave the menu showing no selection. Tabby persists the colour via `tabRecovery.service.ts` (`token.tabColor`) on a 30s save timer — the `color` setter, unlike `pinned`, doesn't request an earlier save, so a colour set just before a hard quit can be lost. That's upstream behaviour and matching it is deliberate.

- `stable-pid` — `/api/tabs` reports each tab's `shellPid` (`pty.getPID()`, the process the PTY spawned) and `/api/tabs/identify` matches on it first. The older `pid` field is Tabby's `getTruePID()`, which `tabby-electron/src/pty.ts` computes **once**, two seconds after spawn, by descending through single-child chains — for a `zsh -c claude …` tab that lands on Claude's own `caffeinate -t 300` helper, dead five minutes later. Measured: 52 of 57 tabs reported a pid that no longer existed, and `whoami` answered `unknown` in a tab with a clean process chain. Without the capability the CLI falls back to argv (`src/core/claude-procs.ts`): a Claude's `--resume <id>` is exact, its `--name` is a spawn-time snapshot and is only trusted when unique both ways.

- `spawn-waits-for-pty` — `POST /api/tabs/new` serialises concurrent creates and doesn't respond until the new tab's process is actually running. Restore spawns in parallel only when this is present; otherwise one at a time with a settle gap.

  Why it exists: a Tabby terminal tab spawns its PTY only after its xterm frontend attaches, which `BaseTerminalTabComponent.ngOnInit` defers until the tab `hasFocus` — and `AppService.addTabRaw → selectTab` blurs the outgoing tab synchronously but emits focus from a `setImmediate` that reads `_activeTab` at callback time. Two creates in one event-loop turn means the first tab is never focused, never attaches, and **never spawns a process at all**. The upstream sources are readable via the sourcemaps in `/Applications/Tabby.app/Contents/Resources/builtin-plugins/*/dist/index.js.map`.

## Key files

- `src/index.ts` — CLI entry point
- `src/commands/` — subcommands (`new`, `fork`, `close`, `send`, etc.)
- `src/core/` — core logic (session management, Wave / Tabby adapters)
- `src/core/restore-plan.ts` — the restore planner: **read-only by construction**, which is what makes `--dry` faithful. `restore.ts` builds entries (from a manifest, or from scanned tabs) and both feed this one planner; `--dry` stops right after it. Don't add mutations here.
- `src/core/config-dirs.ts` — every Claude config dir on the machine (default + one per backend preset that sets `env_CLAUDE_CONFIG_DIR`). Session discovery searches all of them and reports which one each session came from; that origin *is* the backend inference, and it must travel with a session id all the way to launch — resuming an id under the wrong config dir doesn't fail, it silently opens a fresh conversation.
- `src/core/session-copy.ts` — moving a session between Claude config dirs. Every function there encodes a failure that has actually happened, so read the comments before changing one: the **sidecar** (`<session-id>/` beside the .jsonl, holding `subagents/`+`tool-results/` — one session had 357 files) is lost by any copy that only takes the transcript; the copy's **target slug** is the last recorded cwd that still *exists*, not the transcript's own slug, because `--resume` 404s on a slug whose directory is gone; and a **metadata-only trailer** (`custom-title`, `agent-name`, `permission-mode`, no messages) is what a closing Claude writes back to the old path *after* the tab is reported closed — it carries a customTitle with a fresh mtime and therefore shadows the session that was just moved. It is deliberately fs-pure and unit-tested; terminal-side waiting lives in `src/core/tab-exit.ts`.
- `src/core/tab-exit.ts` — waits for a tab to close **and** its pid to disappear. `adapter.deleteBlock()` returning is not the process exiting, and the gap is long enough for the trailer above to be written into it.
- `src/core/tab-match.ts` — shared tab-name matching. Deciding "does this session's tab already exist?" must use `{exact: true}`; the prefix fallback is only for hand-typed targets.
- `skills/cctabs/SKILL.md` — Claude Code skill (must be synced to `generativereality/plugins`)
- `.claude-plugin/plugin.json` — plugin manifest (version must match `package.json`)

## Conventions

- `npm run check` = typecheck + test + build. `npm test` is scoped to `src/` on purpose — a bare `bun test` also globs the sibling checkouts under `related-repos/` and reports their failures as ours.
- Verifying which sessions are alive: use `cctabs sessions` or the plugin's `/api/tabs`. **Never `ps aux | grep`** — it truncates long command lines, so a tab whose `--name` falls past the cutoff reads as dead when it isn't. Code that reads the process table goes through `readProcessTable()` in `src/core/claude-procs.ts`, which passes `-ww` for exactly that reason.
- `src/core/claude-procs.ts` — the process table as a source of truth. Trust a Claude's `--resume` for its **session id**; never trust its `--name` for the **tab's** name (it doesn't follow a rename). `fleet-manifest.ts` and `restart-plan.ts` are the pure halves of `cctabs manifest` / `cctabs restart`, and every rule in them is a correction a hand-run fleet restart needed.
