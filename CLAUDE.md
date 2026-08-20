# cctabs

Claude Code tab manager. Terminal tabs as the UI, no tmux.

## Two packages ship from this repo

| Package | Source | Notes |
|---|---|---|
| `@generativereality/cctabs` | `src/` | the CLI. Scoped — the token in `~/.npmrc` can publish this one. |
| `tabby-cctabs` | `tabby-plugin/` | the Tabby-side plugin. **Unscoped**, so the `~/.npmrc` token 403s on it; needs a token granted that package explicitly. |

They version independently and are published separately. A CLI release does
not require a plugin release — the CLI feature-detects what the plugin can do
(see **Plugin capabilities**) and degrades rather than breaking.

## Release flow

1. Make changes in `src/` and/or `skills/`
2. Bump version in **both** `package.json` and `.claude-plugin/plugin.json` (keep in sync)
3. Run `npm run sync-plugin` — syncs plugin.json + SKILL.md to `../plugins` repo, commits, pushes
4. Publish to npm (requires an **Automation** token to bypass 2FA):
   ```bash
   npm publish --registry https://registry.npmjs.org --//registry.npmjs.org/:_authToken=<token>
   ```
   `prepack` will block publish if the plugins repo is out of sync.
5. Commit and push this repo
6. Users update via Claude Code: `/plugins` → Marketplaces → Update generativereality → update cctabs plugin

**Note:** Claude Code only discovers skills from directory-sourced plugins in the marketplace repo (npm source doesn't support skill discovery). The `sync-plugin` script keeps `generativereality/plugins` in sync. Requires the plugins repo checked out at `../plugins`.

### Releasing the Tabby plugin

Only needed when `tabby-plugin/src/` changed. Its version is independent of the
CLI's, and **npm forbids republishing a version**, so if the currently published
version already exists with different contents, bump — don't reuse it.

```bash
cd tabby-plugin
../related-repos/tabby/node_modules/.bin/webpack   # `npm run build` alone fails: webpack isn't a local dep
npm run sideload                                   # copy into Tabby's plugins dir for local testing
npm publish --access public --//registry.npmjs.org/:_authToken=<token-with-tabby-cctabs-access>
```

- Building needs a Tabby checkout at `related-repos/tabby` with its deps installed — the webpack config delegates to Tabby's own `webpack.plugin.config.mjs`.
- `dist/` is gitignored and published from a local build, so **build before publishing** or you ship whatever is stale on disk.
- Keep `PLUGIN_VERSION` in `tabby-plugin/src/server.ts` in step with `tabby-plugin/package.json` — it's what `/api/health` reports, and it silently drifted a release behind once.
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
