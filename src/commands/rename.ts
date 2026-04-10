import { define } from 'gunshi'
import { consola } from 'consola'
import { requireWaveAdapter } from '../core/wave.js'

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
    if (!query || !newName) { consola.error('Usage: herd rename <tab> <new-name>'); process.exit(1) }
    const adapter = requireWaveAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matches = adapter.resolveTab(query, tabsById, tabNames)
    if (!matches.length) { consola.error(`No tab matching '${query}'`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }
    const oldName = tabNames.get(matches[0]) ?? matches[0].slice(0, 8)
    await adapter.renameTab(matches[0], newName)
    adapter.closeSocket()
    consola.success(`Renamed "${oldName}" → "${newName}"`)
  },
})
