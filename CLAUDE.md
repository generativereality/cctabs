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
- Sideloading only changes files on disk; **Tabby must be restarted/reloaded** to run the new plugin.

### Before releasing, check the docs that ship

`skills/cctabs/SKILL.md` is synced to the marketplace **and** included in the npm
tarball, so a stale claim in it reaches every user. It has twice described
behavior that had already been inverted by an unreleased commit. Re-read the
sections your change touches.

## Plugin capabilities

`/api/health` returns `{ok, version, capabilities: [...]}`. The CLI probes it via
`TerminalAdapter.backendCapabilities()` and adapts, because a user's installed
plugin is routinely older than the CLI talking to it. Add behavior that depends
on a plugin fix as a **new capability token**, never as a version comparison.

- `tab-color` — tabs carry a colour: reported on `/api/tabs`, accepted by `POST /api/tabs/new`, and settable via `PUT /api/tabs/:uuid/color`. `--color` and `cctabs color` probe for this and degrade with one warning, because an older plugin drops the unknown `color` field silently — indistinguishable from a colour that was applied and didn't render.

  The colour is assigned straight to `BaseTabComponent.color`, which is literally what Tabby's own right-click → Color menu does (`tabby-core/src/tabContextMenu.ts`), so a cctabs-set colour is indistinguishable from a hand-set one. `src/core/colors.ts` mirrors Tabby's `TAB_COLORS` **hex values**, not just its names: that menu ticks its radio by comparing `tab.color === color.value`, so a different blue would colour the tab and still leave the menu showing no selection. Tabby persists the colour via `tabRecovery.service.ts` (`token.tabColor`) on a 30s save timer — the `color` setter, unlike `pinned`, doesn't request an earlier save, so a colour set just before a hard quit can be lost. That's upstream behaviour and matching it is deliberate.

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
- Verifying which sessions are alive: use `cctabs sessions` or the plugin's `/api/tabs`. **Never `ps aux | grep`** — it truncates long command lines, so a tab whose `--name` falls past the cutoff reads as dead when it isn't.
