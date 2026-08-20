import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { applyTabColor, resolveTabColor, TAB_COLORS, TAB_COLOR_NAMES } from '../core/colors.js'

/** Palette name for a resolved colour, so output names what the user typed. */
function describeColor(color: string | null): string {
  if (color === null) return 'none'
  const name = Object.keys(TAB_COLORS).find((k) => TAB_COLORS[k] === color)
  return name ? `${name} (${color})` : color
}

export const colorCommand = define({
  name: 'color',
  description: 'Set or clear a tab\'s colour',
  args: {
    tab: { type: 'positional', description: 'Tab name or ID prefix' },
    color: { type: 'positional', description: `Colour: ${TAB_COLOR_NAMES.join(', ')} or a hex value like "#0275d8"` },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    const colorInput = ctx.positionals[2]
    if (!query || colorInput === undefined) {
      consola.error(`Usage: cctabs color <tab> <${TAB_COLOR_NAMES.join('|')}|#rrggbb>`)
      process.exit(1)
    }

    // Validate before touching the terminal, so a typo costs nothing.
    let color: string | null
    try {
      color = resolveTabColor(colorInput)
    } catch (e) {
      consola.error((e as Error).message)
      process.exit(1)
    }

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
    const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
    // Reported only by plugins that advertise `tab-color`; undefined means
    // "unknown", which is why it's only mentioned when we actually have it.
    const previous = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.color

    const applied = await applyTabColor(adapter, tabId, color)
    adapter.closeSocket()

    if (!applied) {
      // supportsTabColor() has already explained why. Exit non-zero: unlike a
      // spawn, colouring *is* the whole job here, so silently succeeding would
      // be a lie.
      process.exit(1)
    }

    const from = previous !== undefined && previous !== color ? `${describeColor(previous)} → ` : ''
    consola.success(`Tab "${tabName}" colour: ${from}${describeColor(color)}`)
  },
})
