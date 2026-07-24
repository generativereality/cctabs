import { describe, it, expect } from 'bun:test'
import type { TerminalAdapter } from '../core/adapter.js'
import type { AllData, Block, SessionStatus } from '../types/index.js'
import { planRestore, type PlannedEntry, type RestoreAction } from '../core/restore-plan.js'
import { buildPlanDeps, describeDecision, summarizeDecision } from './restore.js'

/**
 * An adapter that answers reads and throws on every mutation.
 *
 * This is the dry-run guarantee under test: `--dry` runs the exact same
 * planning wiring a real restore does, so if planning could mutate anything,
 * these calls would blow up here.
 */
function stubAdapter(tabs: Array<{ id: string; name: string; status: SessionStatus }>): {
  adapter: TerminalAdapter
  tabsById: Map<string, Block[]>
  tabNames: Map<string, string>
} {
  const tabsById = new Map<string, Block[]>(
    tabs.map((t) => [t.id, [{ blockid: `block-${t.id}`, tabid: t.id, view: 'term' }]]),
  )
  const tabNames = new Map<string, string>(tabs.map((t) => [t.id, t.name]))
  const statusById = new Map(tabs.map((t) => [`block-${t.id}`, t.status]))
  const mutation = (name: string) => () => {
    throw new Error(`planning must not mutate: ${name}`)
  }

  const adapter: TerminalAdapter = {
    getAllData: async (): Promise<AllData> => ({ blocks: [], tabsById, workspaces: [], tabNames }),
    closeSocket: () => {},
    blocksList: () => [...tabsById.values()].flat(),
    scrollback: () => '',
    confirmScrollbackEmpty: async () => true,
    detectSessionStatus: (blockId) => statusById.get(blockId) ?? 'unknown',
    deleteBlock: mutation('deleteBlock'),
    newTab: mutation('newTab'),
    waitForNewBlock: mutation('waitForNewBlock'),
    renameTab: mutation('renameTab'),
    sendInput: mutation('sendInput'),
    openTabDirect: mutation('openTabDirect'),
    reorderTabs: mutation('reorderTabs'),
    resolveTab: (query, byId, names, opts) => {
      const q = query.toLowerCase()
      const ids = [...byId.keys()]
      const exact = ids.filter((tid) => (names.get(tid) ?? '').toLowerCase() === q)
      if (exact.length || opts?.exact) return exact
      return ids.filter((tid) => (names.get(tid) ?? '').toLowerCase().startsWith(q))
    },
    resolveBlock: () => [],
    resolveWorkspace: () => [],
    currentTabId: () => 'current',
    currentBlockId: () => 'block-current',
    currentWorkspaceId: () => 'ws',
  }
  return { adapter, tabsById, tabNames }
}

describe('buildPlanDeps', () => {
  it('plans against a live adapter without mutating anything', async () => {
    const { adapter, tabsById, tabNames } = stubAdapter([
      { id: 't1', name: 'alpha', status: 'terminal' },
      { id: 't2', name: 'beta', status: 'active' },
    ])

    const plan = await planRestore(
      // A directory with no Claude project dir behind it, so session lookup
      // resolves to "none" without touching the user's real sessions.
      [{ name: 'alpha', dir: '/nonexistent/cctabs-test' }, { name: 'beta', dir: '/nonexistent/cctabs-test' }],
      buildPlanDeps(adapter, {
        tabsById,
        tabNames,
        scopeTabIds: new Set(tabsById.keys()),
        currentTabId: 'current',
        createMissing: false,
      }),
    )

    expect(plan.map((p) => p.action)).toEqual(['no-session', 'already-running'])
  })

  it('matches tabs by exact name only, so a longer-named neighbour is not "already there"', async () => {
    const { adapter, tabsById, tabNames } = stubAdapter([
      { id: 't1', name: 'gapminder-login', status: 'active' },
    ])
    const deps = buildPlanDeps(adapter, {
      tabsById,
      tabNames,
      scopeTabIds: new Set(tabsById.keys()),
      currentTabId: 'current',
      createMissing: false,
    })
    expect(deps.matchTabs('gapminder')).toEqual([])
    expect(deps.matchTabs('gapminder-login')).toEqual(['t1'])
  })
})

const ALL_ACTIONS: RestoreAction[] = [
  'current-tab',
  'already-running',
  'ambiguous',
  'no-terminal',
  'no-session',
  'attach',
  'recreate',
  'duplicate',
  'spawn',
  'missing',
]

/** Actions a real run actually carries out; everything else is just reported. */
const EXECUTED: RestoreAction[] = ['attach', 'recreate', 'spawn']

const planned = (action: RestoreAction, extra: Partial<PlannedEntry> = {}): PlannedEntry => ({
  entry: { name: 'alpha', dir: '/dir/alpha' },
  action,
  sessionId: 'abcdef0123456789',
  dir: '/dir/alpha',
  ...extra,
})

describe('restore output parity', () => {
  it('describes and summarises every action', () => {
    for (const action of ALL_ACTIONS) {
      for (const dry of [true, false]) {
        expect(describeDecision(planned(action), dry)).toBeTruthy()
        expect(summarizeDecision(planned(action), dry)).toBeTruthy()
      }
    }
  })

  it('reports skipped entries identically in a dry run and a real one', () => {
    for (const action of ALL_ACTIONS.filter((a) => !EXECUTED.includes(a))) {
      const p = planned(action)
      // The duplicate line is only conditional on whether a tab gets closed.
      if (action === 'duplicate') continue
      expect(summarizeDecision(p, true)).toBe(summarizeDecision(p, false))
      expect(describeDecision(p, true)).toBe(describeDecision(p, false))
    }
  })

  it('marks the entries a real run would act on as dry-run decisions', () => {
    for (const action of EXECUTED) {
      const p = planned(action)
      expect(summarizeDecision(p, true)).toStartWith('dry run:')
      expect(summarizeDecision(p, false)).not.toStartWith('dry run:')
      expect(describeDecision(p, true)).toContain('would')
    }
  })

  it('says it would close a duplicate tab only when a real run would close it', () => {
    const closes = planned('duplicate', { closeTabId: 't2' })
    expect(summarizeDecision(closes, true)).toBe('dry run: close duplicate dead tab')
    expect(summarizeDecision(closes, false)).toBe('duplicate dead tab — closed')

    const keeps = planned('duplicate')
    expect(summarizeDecision(keeps, true)).toBe(summarizeDecision(keeps, false))
  })

  it('names the session it would resume', () => {
    expect(describeDecision(planned('attach'), true)).toContain('abcdef01…')
    expect(describeDecision(planned('spawn', { sessionId: undefined }), true)).toContain('fresh')
  })
})
