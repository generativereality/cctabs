# cctabs

Claude Code tab manager. Terminal tabs as the UI, no tmux.

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

## Key files

- `src/index.ts` — CLI entry point
- `src/commands/` — subcommands (`new`, `fork`, `close`, `send`, etc.)
- `src/core/` — core logic (session management, Wave Terminal adapter)
- `skills/herd/SKILL.md` — Claude Code skill (must be synced to `generativereality/plugins`)
- `.claude-plugin/plugin.json` — plugin manifest (version must match `package.json`)
