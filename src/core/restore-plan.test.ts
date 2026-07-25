import { describe, it, expect } from 'bun:test'
import type { SessionStatus } from '../types/index.js'
import {
  planRestore,
  buildDesiredOrder,
  type PlanDeps,
  type PlannedEntry,
  type RestoreEntry,
} from './restore-plan.js'
import { matchTabsByName } from './tab-match.js'

interface FakeTab {
  id: string
  name: string
  status: SessionStatus
  /** For 'unknown' tabs: does the scrollback re-check confirm it's really dead? */
  empty?: boolean
  /** A tab with no terminal in it (e.g. a Wave web-view tab). */
  noTerm?: boolean
}

/** Every dependency the planner is allowed to have, plus a call log. */
function makeDeps(
  tabs: FakeTab[],
  opts: {
    currentTabId?: string
    createMissing?: boolean
    /** Names with no resumable session. */
    sessionless?: string[]
    calls?: string[]
  } = {},
): PlanDeps {
  const names = new Map(tabs.map((t) => [t.id, t.name]))
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const log = (what: string) => opts.calls?.push(what)

  return {
    currentTabId: opts.currentTabId ?? 'current',
    scopeTabIds: new Set(tabs.map((t) => t.id)),
    matchTabs: (name) => {
      log(`matchTabs:${name}`)
      return matchTabsByName(name, [...names.keys()], names, { exact: true })
    },
    termBlockOf: (tabId) => (byId.get(tabId)?.noTerm ? undefined : `block-${tabId}`),
    statusOf: (blockId) => {
      log(`statusOf:${blockId}`)
      return byId.get(blockId.replace(/^block-/, ''))?.status ?? 'unknown'
    },
    confirmEmpty: async (blockId) => {
      log(`confirmEmpty:${blockId}`)
      return byId.get(blockId.replace(/^block-/, ''))?.empty ?? false
    },
    resolveSession: (entry) => {
      log(`resolveSession:${entry.name}`)
      if (opts.sessionless?.includes(entry.name)) return null
      return { id: `sess-${entry.name}`, dir: `/dir/${entry.name}` }
    },
    createMissing: opts.createMissing ?? false,
  }
}

const actionsOf = (plan: PlannedEntry[]) =>
  Object.fromEntries(plan.map((p) => [p.entry.name, p.action]))

/** Manifest-style entry: named, with a directory, not bound to a tab. */
const mEntry = (name: string, extra: Partial<RestoreEntry> = {}): RestoreEntry =>
  ({ name, dir: `/dir/${name}`, ...extra })

/** Scan-style entry: bound to the tab it was derived from. */
const sEntry = (name: string, tabId: string): RestoreEntry => ({ name, tabId })

describe('planRestore — manifest entries', () => {
  it('attaches to a tab whose shell is alive but has no Claude', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'terminal' }]),
    )
    expect(plan[0]).toMatchObject({
      action: 'attach',
      tabId: 't1',
      blockId: 'block-t1',
      sessionId: 'sess-alpha',
      dir: '/dir/alpha',
    })
    expect(plan[0].closeTabId).toBeUndefined()
  })

  it('leaves a tab that is already running Claude alone', async () => {
    for (const status of ['active', 'idle'] as SessionStatus[]) {
      const plan = await planRestore(
        [mEntry('alpha')],
        makeDeps([{ id: 't1', name: 'alpha', status }]),
      )
      expect(plan[0].action).toBe('already-running')
      expect(plan[0].closeTabId).toBeUndefined()
    }
  })

  it('recreates a tab whose terminal is confirmed dead', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'unknown', empty: true }]),
    )
    expect(plan[0]).toMatchObject({ action: 'recreate', closeTabId: 't1', sessionId: 'sess-alpha' })
  })

  it('attaches instead of recreating when the scrollback turns out not to be empty', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'unknown', empty: false }]),
    )
    expect(plan[0].action).toBe('attach')
    expect(plan[0].closeTabId).toBeUndefined()
  })

  it('spawns a missing tab only with --create-missing', async () => {
    const tabs: FakeTab[] = []
    expect((await planRestore([mEntry('alpha')], makeDeps(tabs)))[0].action).toBe('missing')

    const plan = await planRestore([mEntry('alpha')], makeDeps(tabs, { createMissing: true }))
    expect(plan[0]).toMatchObject({ action: 'spawn', sessionId: 'sess-alpha', dir: '/dir/alpha' })
  })

  it('spawns a fresh Claude when a missing tab has no session to resume', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([], { createMissing: true, sessionless: ['alpha'] }),
    )
    expect(plan[0].action).toBe('spawn')
    expect(plan[0].sessionId).toBeUndefined()
    expect(plan[0].dir).toBe('/dir/alpha')
  })

  // The restore-the-coordination-tab-twice bug: filtering the current tab out
  // makes its entry look missing, and --create-missing then clones it.
  it('recognises the tab it is running in and never respawns it', async () => {
    const plan = await planRestore(
      [mEntry('coord')],
      makeDeps([{ id: 'current', name: 'coord', status: 'active' }], {
        currentTabId: 'current',
        createMissing: true,
      }),
    )
    expect(plan[0]).toMatchObject({ action: 'current-tab', tabId: 'current' })
  })

  it('skips a name that matches more than one tab', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([
        { id: 't1', name: 'alpha', status: 'terminal' },
        { id: 't2', name: 'alpha', status: 'terminal' },
      ]),
    )
    expect(plan[0].action).toBe('ambiguous')
    expect(plan[0].tabId).toBeUndefined()
  })

  it('skips a matching tab that holds no terminal', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'terminal', noTerm: true }]),
    )
    expect(plan[0]).toMatchObject({ action: 'no-terminal', tabId: 't1' })
  })

  it('skips an existing tab when no session can be found for it', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'terminal' }], { sessionless: ['alpha'] }),
    )
    expect(plan[0].action).toBe('no-session')
  })

  it('ignores tabs outside the scope', async () => {
    const deps = makeDeps([{ id: 't1', name: 'alpha', status: 'terminal' }], { createMissing: true })
    deps.scopeTabIds = new Set()
    const plan = await planRestore([mEntry('alpha')], deps)
    expect(plan[0].action).toBe('spawn')
  })

  it('never restores the same name twice, and never closes a tab it does not own', async () => {
    const plan = await planRestore(
      [mEntry('alpha'), mEntry('alpha')],
      makeDeps([{ id: 't1', name: 'alpha', status: 'terminal' }]),
    )
    expect(plan.map((p) => p.action)).toEqual(['attach', 'duplicate'])
    expect(plan[1].closeTabId).toBeUndefined()
  })

  it('does not spawn a duplicate for a repeated missing entry', async () => {
    const plan = await planRestore(
      [mEntry('alpha'), mEntry('alpha')],
      makeDeps([], { createMissing: true }),
    )
    expect(plan.map((p) => p.action)).toEqual(['spawn', 'duplicate'])
  })
})

describe('planRestore — scanned tabs', () => {
  it('binds each entry to its own tab, so same-named dead tabs are told apart', async () => {
    const tabs: FakeTab[] = [
      { id: 't1', name: 'notes', status: 'unknown', empty: true },
      { id: 't2', name: 'notes', status: 'unknown', empty: true },
    ]
    const plan = await planRestore([sEntry('notes', 't1'), sEntry('notes', 't2')], makeDeps(tabs))
    expect(plan[0]).toMatchObject({ action: 'recreate', closeTabId: 't1' })
    // The extra dead tab is closed rather than resumed into a second copy of
    // the same session.
    expect(plan[1]).toMatchObject({ action: 'duplicate', closeTabId: 't2' })
  })

  it('reports a live tab and refuses to restore a dead namesake over it', async () => {
    const tabs: FakeTab[] = [
      { id: 't1', name: 'notes', status: 'active' },
      { id: 't2', name: 'notes', status: 'terminal' },
    ]
    const plan = await planRestore([sEntry('notes', 't1'), sEntry('notes', 't2')], makeDeps(tabs))
    expect(plan.map((p) => p.action)).toEqual(['already-running', 'duplicate'])
    // Nothing here brought that session back, so the leftover tab is reported,
    // not closed.
    expect(plan[1].closeTabId).toBeUndefined()
  })

  it('plans a mixed bar in one pass', async () => {
    const tabs: FakeTab[] = [
      { id: 't1', name: 'live', status: 'active' },
      { id: 't2', name: 'shell', status: 'terminal' },
      { id: 't3', name: 'dead', status: 'unknown', empty: true },
      { id: 't4', name: 'orphan', status: 'terminal' },
    ]
    const plan = await planRestore(
      tabs.map((t) => sEntry(t.name, t.id)),
      makeDeps(tabs, { sessionless: ['orphan'] }),
    )
    expect(actionsOf(plan)).toEqual({
      live: 'already-running',
      shell: 'attach',
      dead: 'recreate',
      orphan: 'no-session',
    })
  })
})

describe('planRestore — dry-run parity', () => {
  // Planning is the whole decision: there is no dry flag to diverge on, and
  // every dependency is a read. These two tests pin that down, because the old
  // dry run skipped the empty-scrollback check and the duplicate dedup and so
  // promised restores a real run would never have performed.
  it('takes no mutating action — the deps surface is read-only', async () => {
    const calls: string[] = []
    const tabs: FakeTab[] = [
      { id: 't1', name: 'alpha', status: 'unknown', empty: true },
      { id: 't2', name: 'alpha', status: 'unknown', empty: true },
    ]
    await planRestore([sEntry('alpha', 't1'), sEntry('alpha', 't2')], makeDeps(tabs, { calls }))

    const reads = ['matchTabs', 'statusOf', 'confirmEmpty', 'resolveSession']
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(reads).toContain(c.split(':')[0])
  })

  it('reaches identical decisions whether or not the caller intends to execute', async () => {
    const tabs: FakeTab[] = [
      { id: 't1', name: 'alpha', status: 'unknown', empty: true },
      { id: 't2', name: 'alpha', status: 'unknown', empty: true },
      { id: 't3', name: 'beta', status: 'terminal' },
    ]
    const entries = [sEntry('alpha', 't1'), sEntry('alpha', 't2'), sEntry('beta', 't3')]
    const dry = await planRestore(entries, makeDeps(tabs))
    const real = await planRestore(entries, makeDeps(tabs))
    expect(real.map((p) => ({ ...p, entry: p.entry.name })))
      .toEqual(dry.map((p) => ({ ...p, entry: p.entry.name })))
    // …and the decisions the old dry run got wrong are present in both.
    expect(dry.map((p) => p.action)).toEqual(['recreate', 'duplicate', 'attach'])
  })
})

describe('buildDesiredOrder', () => {
  it('rebuilds the pre-restore bar, swapping recreated tabs in place', () => {
    const order = buildDesiredOrder(
      [],
      new Map([['dead1', 'new1'], ['dead2', 'new2']]),
      ['live1', 'dead1', 'current', 'dead2'],
    )
    expect(order).toEqual(['live1', 'new1', 'current', 'new2'])
  })

  it('drops tabs that were closed without a replacement', () => {
    const order = buildDesiredOrder([], new Map([['dupe', null]]), ['a', 'dupe', 'b'])
    expect(order).toEqual(['a', 'b'])
  })

  it('keeps a tab that failed to be recreated out of the order rather than pointing at a corpse', () => {
    // A spawn failure never records a replacement, so the dead id stays mapped
    // to null and drops out.
    const order = buildDesiredOrder([], new Map([['dead1', null]]), ['dead1', 'live1'])
    expect(order).toEqual(['live1'])
  })

  it('leaves untouched tabs alone', () => {
    const order = buildDesiredOrder([], new Map(), ['a', 'b', 'c'])
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('uses manifest order when there is no base order', () => {
    const order = buildDesiredOrder(['t3', undefined, 't1'], new Map())
    expect(order).toEqual(['t3', 't1'])
  })
})

/**
 * A session's Claude config dir has to survive planning. Losing it is silent:
 * `claude --resume <id>` in the default config dir doesn't fail, it just can't
 * find that id and opens a fresh conversation instead.
 */
describe('planRestore — session origin', () => {
  const gapminder = { id: 'sess-alpha', dir: '/dir/alpha', backend: 'gapminder', configDir: '/home/x/.claude-gapminder' }

  function depsWithOrigin(tabs: FakeTab[], session: typeof gapminder | null, createMissing = false): PlanDeps {
    const deps = makeDeps(tabs, { createMissing })
    deps.resolveSession = () => session
    return deps
  }

  it('carries the backend onto an attach', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      depsWithOrigin([{ id: 't1', name: 'alpha', status: 'terminal' }], gapminder),
    )
    expect(plan[0]).toMatchObject({
      action: 'attach',
      backend: 'gapminder',
      configDir: '/home/x/.claude-gapminder',
    })
  })

  it('carries the backend onto a recreate and a spawn', async () => {
    const recreate = await planRestore(
      [mEntry('alpha')],
      depsWithOrigin([{ id: 't1', name: 'alpha', status: 'unknown', empty: true }], gapminder),
    )
    expect(recreate[0]).toMatchObject({ action: 'recreate', backend: 'gapminder' })

    const spawn = await planRestore([mEntry('alpha')], depsWithOrigin([], gapminder, true))
    expect(spawn[0]).toMatchObject({ action: 'spawn', backend: 'gapminder' })
  })

  it('leaves a default-config-dir session with no backend', async () => {
    const plan = await planRestore(
      [mEntry('alpha')],
      depsWithOrigin([{ id: 't1', name: 'alpha', status: 'terminal' }], { id: 'sess-alpha', dir: '/dir/alpha' } as typeof gapminder),
    )
    expect(plan[0].backend).toBeUndefined()
    expect(plan[0].configDir).toBeUndefined()
  })

  it('lets a manifest override what discovery inferred', async () => {
    // The manifest is a deliberate statement about which account owns the tab,
    // and it may name a config dir whose transcript isn't on this machine yet.
    const entry = { ...mEntry('alpha'), backend: 'other-account' }
    const plan = await planRestore(
      [entry],
      depsWithOrigin([{ id: 't1', name: 'alpha', status: 'terminal' }], gapminder),
    )
    expect(plan[0].backend).toBe('other-account')
    expect(plan[0].configDir).toBeUndefined()
  })

  it('keeps a manifest config dir that no preset names', async () => {
    const entry = { ...mEntry('alpha'), configDir: '/home/x/.claude-adhoc' }
    const plan = await planRestore([entry], depsWithOrigin([], gapminder, true))
    expect(plan[0]).toMatchObject({ action: 'spawn', configDir: '/home/x/.claude-adhoc' })
  })
})
