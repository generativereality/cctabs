import { define } from 'gunshi'
import { consola } from 'consola'
import { join } from 'path'
import { requireWaveAdapter } from '../core/wave.js'
import { findLatestSessionId, pathToProjectSlug } from '../core/session.js'
import { openSession } from '../core/open-session.js'

/** If dir is inside .claude/worktrees/<name>, return the repo root instead */
function resolveSessionDir(dir: string): { sessionLookupDir: string; openDir: string } {
  const worktreeMarker = `${join('.claude', 'worktrees')}` + '/'
  const idx = dir.indexOf(worktreeMarker)
  if (idx !== -1) {
    const repoRoot = dir.slice(0, idx - 1)
    return { sessionLookupDir: repoRoot, openDir: repoRoot }
  }
  return { sessionLookupDir: dir, openDir: dir }
}

export const forkCommand = define({
  name: 'fork',
  description: 'Fork a session into a new tab via --resume <id> --fork-session',
  args: {
    tab: { type: 'positional', description: 'Source tab name or ID prefix' },
    name: { type: 'string', short: 'n', description: 'Name for the new tab' },
  },
  async run(ctx) {
    const sourceQuery = ctx.positionals[1]
    const customName = ctx.values.name
    if (!sourceQuery) { consola.error('Source tab name is required'); process.exit(1) }

    const adapter = requireWaveAdapter()
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
    const newName = customName ?? `${tabName}-fork`
    const termBlocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
    if (!termBlocks.length) { consola.error(`Tab "${tabName}" has no terminal block`); process.exit(1) }

    const rawDir = termBlocks[0].meta?.['cmd:cwd'] ?? process.cwd()
    const { sessionLookupDir, openDir } = resolveSessionDir(rawDir)

    const sessionId = findLatestSessionId(sessionLookupDir)
    if (!sessionId) {
      consola.error(`No Claude session found for ${sessionLookupDir}`)
      consola.info(`Looked in ~/.claude/projects/${pathToProjectSlug(sessionLookupDir)}/`)
      process.exit(1)
    }

    const newTabId = await openSession({
      tabName: newName,
      dir: openDir,
      claudeCmd: `claude --resume ${sessionId} --fork-session`,
    })
    consola.success(`Forked "${tabName}" → "${newName}" [${newTabId.slice(0, 8)}]`)
    consola.info(`session: ${sessionId}`)
  },
})
