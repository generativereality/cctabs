import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabSession, findSessionFileById, persistSessionTitle } from '../core/session.js'

export const renameCommand = define({
  name: 'rename',
  description: 'Rename a tab',
  args: {
    tab: { type: 'positional', description: 'Tab name or ID prefix' },
    newName: { type: 'positional', description: 'New name' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    const newName = ctx.positionals[2]
    if (!query || !newName) { consola.error('Usage: cctabs rename <tab> <new-name>'); process.exit(1) }
    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matches = adapter.resolveTab(query, tabsById, tabNames)
    if (!matches.length) { consola.error(`No tab matching '${query}'`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }
    const tabId = matches[0]
    const oldName = tabNames.get(tabId) ?? tabId.slice(0, 8)
    await adapter.renameTab(tabId, newName)

    // Also persist the new name to the session's .jsonl so `cctabs resume
    // <newName>` finds it. renameTab only relabels the live tab; without this,
    // name resolution (which reads the on-disk customTitle) still sees oldName.
    // Best-effort: a tab with no resolvable Claude session (e.g. a plain shell)
    // simply gets the tab relabelled, same as before.
    let persisted = false
    try {
      const cwd = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.meta?.['cmd:cwd'] ?? ''
      if (cwd) {
        const resolved = resolveTabSession(cwd, oldName)
        const file = resolved ? findSessionFileById(resolved.id, [resolved.dir, cwd]) : null
        if (resolved && file) {
          persistSessionTitle(file, resolved.id, newName)
          persisted = true
        }
      }
    } catch {
      // best-effort — never fail the rename over the disk sync
    }

    adapter.closeSocket()
    if (persisted) {
      consola.success(`Renamed "${oldName}" → "${newName}" (session title updated on disk)`)
    } else {
      consola.success(`Renamed "${oldName}" → "${newName}"`)
      consola.info('Note: no on-disk Claude session matched this tab, so `cctabs resume` still keys off the previous name.')
    }
  },
})
