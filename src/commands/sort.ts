import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { buildTitleActivityMap } from '../core/session.js'

function relAge(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export interface RankedTab {
  tid: string
  name: string
  /** mtime of the newest transcript titled `name`, or 0 when none matched. */
  mtime: number
}

/**
 * Rank tabs by the activity of the Claude session sharing their name.
 *
 * Pure and separate from the command so the ordering rules — especially where
 * session-less tabs land — are testable without a terminal.
 */
export function rankTabsByActivity(
  tabIds: string[],
  tabNames: Map<string, string>,
  titleMtimes: Map<string, number>,
  reverse = false,
): RankedTab[] {
  const ranked = tabIds.map((tid, origIndex) => {
    const name = tabNames.get(tid) ?? tid.slice(0, 8)
    return { tid, name, mtime: titleMtimes.get(name) ?? 0, origIndex }
  })

  ranked.sort((a, b) => {
    // Tabs with no matching session sink to the end, keeping original order.
    if (!a.mtime && !b.mtime) return a.origIndex - b.origIndex
    if (!a.mtime) return 1
    if (!b.mtime) return -1
    return reverse ? a.mtime - b.mtime : b.mtime - a.mtime
  })

  return ranked.map(({ tid, name, mtime }) => ({ tid, name, mtime }))
}

export const sortCommand = define({
  name: 'sort',
  description: 'Reorder tabs by Claude session activity (most-recent first).',
  args: {
    dry: { type: 'boolean', short: 'n', description: 'Show planned order without applying it' },
    'dry-run': { type: 'boolean', description: 'Alias for --dry' },
    reverse: { type: 'boolean', short: 'r', description: 'Oldest first instead of newest' },
  },
  async run(ctx) {
    const dryRun = !!(ctx.values.dry || ctx.values['dry-run'])
    const reverse = !!ctx.values.reverse
    const adapter = requireAdapter()

    if (typeof adapter.reorderTabs !== 'function') {
      consola.error('Tab reordering is not supported by this terminal (Tabby only for now).')
      process.exit(1)
    }

    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const titleMtimes = buildTitleActivityMap()
    const now = Date.now()

    for (const wsp of workspaces) {
      const tabIds = wsp.workspacedata.tabids.filter((t) => tabsById.has(t))
      if (!tabIds.length) continue

      const ranked = rankTabsByActivity(tabIds, tabNames, titleMtimes, reverse)

      consola.info(`${reverse ? 'Oldest' : 'Newest'} first:`)
      for (const r of ranked) {
        const age = r.mtime ? relAge(now - r.mtime) : '(no session)'
        consola.log(`  ${r.name.padEnd(32)}  ${age}`)
      }

      // Already-sorted short-circuit: skip the round-trip if nothing moves.
      const desiredOrder = ranked.map((r) => r.tid)
      const unchanged = desiredOrder.every((id, i) => id === tabIds[i])
      if (unchanged) {
        consola.info('Already in order.')
        continue
      }

      if (dryRun) {
        consola.info('Dry run — no changes applied.')
        continue
      }

      try {
        await adapter.reorderTabs!(desiredOrder)
        consola.success(`Reordered ${desiredOrder.length} tab(s).`)
      } catch (err) {
        consola.error(`Failed to reorder tabs: ${(err as Error).message}`)
        process.exitCode = 1
      }
    }

    adapter.closeSocket()
  },
})
