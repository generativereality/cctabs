import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { findLatestSessionId, pathToProjectSlug } from '../core/session.js'
import { openSession } from '../core/open-session.js'
import { loadConfig, applyPrefix } from '../core/config.js'
import { repoRootOf } from '../core/worktree.js'
import { resolveBackend, resolveBackendName, backendEnvWithMarker, listBackends } from '../core/backends.js'

export const forkCommand = define({
  name: 'fork',
  description: 'Fork a session into a new tab via --resume <id> --fork-session',
  args: {
    tab: { type: 'positional', description: 'Source tab name or ID prefix' },
    name: { type: 'string', short: 'n', description: 'Name for the new tab' },
    backend: { type: 'string', short: 'b', description: 'Backend preset. Defaults to the CURRENT session\'s backend if any (via CCTABS_ACTIVE_BACKEND) — pass -b anthropic to force the default back explicitly. Run `cctabs backends` to list.' },
  },
  async run(ctx) {
    const sourceQuery = ctx.positionals[1]
    const customName = ctx.values.name
    if (!sourceQuery) { consola.error('Source tab name is required'); process.exit(1) }

    const explicitBackend = ctx.values.backend as string | undefined
    const backendName = resolveBackendName(explicitBackend)
    let envVars: Record<string, string> | undefined
    if (backendName) {
      const backend = resolveBackend(backendName)
      if (!backend) {
        consola.error(`Unknown backend "${backendName}". Available:`)
        for (const b of listBackends()) consola.log(`  ${b.name.padEnd(22)} ${b.description}`)
        process.exit(1)
      }
      envVars = backendEnvWithMarker(backendName, backend)
    }
    const inheritedBackend = !explicitBackend && !!backendName
    const be = backendName ? ` [backend: ${backendName}${inheritedBackend ? ' (inherited)' : ''}]` : ''

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matches = adapter.resolveTab(sourceQuery, tabsById, tabNames)

    if (!matches.length) { consola.error(`No tab matching '${sourceQuery}' (tabs in workspaces with no open window are not visible — open that workspace first)`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${sourceQuery}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }

    const tabId = matches[0]
    const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
    // Prefix the freshly-minted fork name so its tab title + `claude --name`
    // (RC name) match this machine's convention. Idempotent, so a default of
    // `<already-prefixed-source>-fork` isn't prefixed twice.
    const newName = applyPrefix(customName ?? `${tabName}-fork`, loadConfig().defaults.prefix)
    const termBlocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
    if (!termBlocks.length) { consola.error(`Tab "${tabName}" has no terminal block`); process.exit(1) }

    // A worktree tab's session lives under the repo root for lookup purposes,
    // and that's also where the fork should open. Shared with `profile-copy`,
    // which needs the same mapping when a worktree has been deleted.
    const rawDir = termBlocks[0].meta?.['cmd:cwd'] ?? process.cwd()
    const sessionLookupDir = repoRootOf(rawDir)
    const openDir = sessionLookupDir

    const sessionId = findLatestSessionId(sessionLookupDir)
    if (!sessionId) {
      consola.error(`No Claude session found for ${sessionLookupDir}`)
      consola.info(`Looked in ~/.claude/projects/${pathToProjectSlug(sessionLookupDir)}/`)
      process.exit(1)
    }

    const newTabId = await openSession({
      tabName: newName,
      dir: openDir,
      // `--name` names the forked RC session to match the new tab (previously a
      // fork left the session unnamed) so it's distinguishable — and prefixed —
      // on claude.ai.
      claudeCmd: `claude --resume ${sessionId} --fork-session --name ${JSON.stringify(newName)}`,
      envVars,
      afterActive: true,
    })
    consola.success(`Forked "${tabName}" → "${newName}" [${newTabId.slice(0, 8)}]${be}`)
    consola.info(`session: ${sessionId}`)
  },
})
