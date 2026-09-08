import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import type { Block } from '../types/index.js'
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

/** What a `--first` request resolved to, before anything is applied. */
export interface PinnedPlan {
  /** Tab ids to place at the front, in the order the caller asked for. */
  order: string[]
  /** The names those ids came from, parallel to `order`, for reporting. */
  names: string[]
  /** Requested names that matched no tab — or matched more than one. */
  unresolved: Array<{ query: string; reason: 'not-found' | 'ambiguous' }>
}

/**
 * Resolve a `--first a,b,c` request into the tab order to POST.
 *
 * Only the pinned ids go in the list, and that is deliberate rather than
 * lazy: the backend's reorder contract is that tabs absent from `order` keep
 * their relative order and sort after the listed ones. So naming three tabs
 * moves exactly those three and disturbs nothing else — which is what pinning
 * means, and why this doesn't need (or want) the activity scan that `sort`
 * otherwise pays ~7.7s of transcript reading for.
 *
 * Duplicates in the request are collapsed to their first mention, so
 * `--first a,b,a` is `a,b` rather than an order that contradicts itself.
 */
export function planPinnedOrder(
  queries: string[],
  resolve: (query: string) => string[],
): PinnedPlan {
  const order: string[] = []
  const names: string[] = []
  const unresolved: PinnedPlan['unresolved'] = []

  for (const query of queries) {
    const matches = resolve(query)
    if (matches.length === 0) { unresolved.push({ query, reason: 'not-found' }); continue }
    if (matches.length > 1) { unresolved.push({ query, reason: 'ambiguous' }); continue }
    if (order.includes(matches[0])) continue
    order.push(matches[0])
    names.push(query)
  }

  return { order, names, unresolved }
}

/** Split a `--first` value on commas, dropping empties and surrounding space. */
export function parseFirstList(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
}

export const sortCommand = define({
  name: 'sort',
  description: 'Reorder tabs by Claude session activity (most-recent first), or pin a chosen set to the front with --first.',
  args: {
    dry: { type: 'boolean', short: 'n', description: 'Show planned order without applying it' },
    'dry-run': { type: 'boolean', description: 'Alias for --dry' },
    reverse: { type: 'boolean', short: 'r', description: 'Oldest first instead of newest' },
    first: { type: 'string', description: 'Pin these tabs to the front of the bar, in this order (comma-separated names or id prefixes). Everything else keeps its current relative order, and no activity ranking is done — use this when you want a chosen working set in reach, which is what activity order actively works against.' },
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

    const firstRaw = ctx.values.first as string | undefined
    if (firstRaw !== undefined) {
      await pinToFront(adapter, firstRaw, tabsById, tabNames, dryRun)
      adapter.closeSocket()
      return
    }

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

/**
 * Apply a `--first` request: move the named tabs to the front of the bar.
 *
 * Refuses as a whole if any name doesn't resolve. Pinning is something a driver
 * does to get a working set in reach, and half a working set in reach — with no
 * indication which half — is worse than an error, because the tabs that failed
 * are exactly the ones that would then be looked for in the wrong place. Same
 * reasoning as restore's true-count reporting: don't claim what wasn't done.
 */
async function pinToFront(
  adapter: TerminalAdapter,
  firstRaw: string,
  tabsById: Map<string, Block[]>,
  tabNames: Map<string, string>,
  dryRun: boolean,
): Promise<void> {
  const queries = parseFirstList(firstRaw)
  if (!queries.length) {
    consola.error('--first needs at least one tab name, e.g. --first auth,payments')
    process.exitCode = 1
    return
  }

  const plan = planPinnedOrder(queries, (q) => adapter.resolveTab(q, tabsById, tabNames))

  if (plan.unresolved.length) {
    consola.error('Not pinning anything — these did not resolve to exactly one tab:')
    for (const u of plan.unresolved) {
      consola.log(`  ${u.query} — ${u.reason === 'ambiguous' ? 'matches several tabs; use a longer name or an id prefix' : 'no such tab'}`)
    }
    process.exitCode = 1
    return
  }

  consola.info(`Pinning ${plan.order.length} tab(s) to the front:`)
  plan.names.forEach((name, i) => {
    consola.log(`  ${i + 1}. ${name}  [${plan.order[i].slice(0, 8)}]`)
  })
  consola.log('  … every other tab keeps its current relative order, after these.')

  if (dryRun) {
    consola.info('Dry run — no changes applied.')
    return
  }

  try {
    await adapter.reorderTabs!(plan.order)
    consola.success(`Pinned ${plan.order.length} tab(s) to the front.`)
  } catch (err) {
    consola.error(`Failed to reorder tabs: ${(err as Error).message}`)
    process.exitCode = 1
  }
}
