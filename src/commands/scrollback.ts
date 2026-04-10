import { define } from 'gunshi'
import { consola } from 'consola'
import { requireWaveAdapter } from '../core/wave.js'

export const scrollbackCommand = define({
  name: 'scrollback',
  description: 'Show terminal output for a tab or block (default: last 50 lines)',
  args: {
    target: { type: 'positional', description: 'Tab name, tab ID prefix, or block ID prefix' },
    lines: { type: 'number', description: 'Number of lines to show', default: 50 },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    const lines = (ctx.values.lines as number | undefined) ?? 50
    if (!query) { consola.error('Tab name or block ID is required'); process.exit(1) }

    const adapter = requireWaveAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()

    // Try tab name resolution first (same logic as `send`)
    const tabMatches = adapter.resolveTab(query, tabsById, tabNames)
    let blockId: string

    if (tabMatches.length === 1) {
      const blocks = (tabsById.get(tabMatches[0]) ?? []).filter((b) => b.view === 'term')
      if (!blocks.length) { consola.error(`Tab "${tabNames.get(tabMatches[0])}" has no terminal block`); process.exit(1) }
      blockId = blocks[0].blockid
    } else if (tabMatches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of tabMatches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    } else {
      // Fall back to block ID prefix resolution
      const allBlocks = adapter.blocksList()
      const blockMatches = adapter.resolveBlock(query, allBlocks)
      if (!blockMatches.length) { consola.error(`No tab or block matching '${query}' (tabs in workspaces with no open window are not visible — open that workspace first)`); process.exit(1) }
      if (blockMatches.length > 1) {
        consola.error(`Multiple blocks match '${query}':`)
        for (const b of blockMatches) consola.log(`  ${b.blockid}`)
        process.exit(1)
      }
      blockId = blockMatches[0].blockid
    }

    process.stdout.write(adapter.scrollback(blockId, lines))
  },
})
