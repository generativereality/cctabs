import { define } from 'gunshi'
import { consola } from 'consola'
import { requireWaveAdapter } from '../core/wave.js'

export const closeCommand = define({
  name: 'close',
  description: 'Close a tab by name or ID prefix',
  args: {
    tab: { type: 'positional', description: 'Tab name or ID prefix' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    if (!query) { consola.error('Tab name or ID is required'); process.exit(1) }
    const adapter = requireWaveAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matches = adapter.resolveTab(query, tabsById, tabNames)
    if (!matches.length) { consola.error(`No tab matching '${query}' (tabs in workspaces with no open window are not visible — open that workspace first)`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }
    const tabId = matches[0]
    const name = tabNames.get(tabId) ?? tabId.slice(0, 8)
    for (const b of tabsById.get(tabId) ?? []) adapter.deleteBlock(b.blockid)
    adapter.closeSocket()
    consola.success(`Closed "${name}" [${tabId.slice(0, 8)}]`)
  },
})
