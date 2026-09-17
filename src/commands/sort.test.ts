import { describe, expect, test } from 'bun:test'
import { parseFirstList, planPinnedOrder, rankTabsByActivity } from './sort.js'

const names = (m: Record<string, string>) => new Map(Object.entries(m))
const times = (m: Record<string, number>) => new Map(Object.entries(m))

describe('rankTabsByActivity', () => {
  test('orders by session activity, newest first', () => {
    const ranked = rankTabsByActivity(
      ['t1', 't2', 't3'],
      names({ t1: 'old', t2: 'newest', t3: 'middle' }),
      times({ old: 100, newest: 300, middle: 200 }),
    )
    expect(ranked.map((r) => r.name)).toEqual(['newest', 'middle', 'old'])
  })

  test('--reverse puts the oldest first', () => {
    const ranked = rankTabsByActivity(
      ['t1', 't2'],
      names({ t1: 'newer', t2: 'older' }),
      times({ newer: 300, older: 100 }),
      true,
    )
    expect(ranked.map((r) => r.name)).toEqual(['older', 'newer'])
  })

  test('session-less tabs sink to the end in their original order', () => {
    const ranked = rankTabsByActivity(
      ['plain-a', 'has-session', 'plain-b'],
      names({ 'plain-a': 'shell', 'has-session': 'claude', 'plain-b': 'editor' }),
      times({ claude: 500 }),
    )
    expect(ranked.map((r) => r.tid)).toEqual(['has-session', 'plain-a', 'plain-b'])
  })

  test('a tab with no name at all falls back to its short id', () => {
    const ranked = rankTabsByActivity(['abcdef1234'], new Map(), new Map())
    expect(ranked[0].name).toBe('abcdef12')
    expect(ranked[0].mtime).toBe(0)
  })

  // The names reaching this function are already normalized by the adapter, so
  // a tab whose title carried Claude's `✳` marker still scores. Guards the
  // regression where such a tab sorted as "(no session)" while being the single
  // most recently active one on the bar.
  test('scores a tab whose glyph-prefixed title was normalized upstream', () => {
    const ranked = rankTabsByActivity(
      ['busy', 'idle'],
      names({ busy: 'career-strategy', idle: 'other' }),
      times({ 'career-strategy': 900, other: 100 }),
    )
    expect(ranked.map((r) => r.name)).toEqual(['career-strategy', 'other'])
  })
})

describe('parseFirstList', () => {
  test('splits on commas and tolerates spacing', () => {
    expect(parseFirstList('auth, payments ,billing')).toEqual(['auth', 'payments', 'billing'])
  })

  test('drops empty entries from stray commas', () => {
    expect(parseFirstList('auth,,payments,')).toEqual(['auth', 'payments'])
    expect(parseFirstList('')).toEqual([])
  })
})

describe('planPinnedOrder', () => {
  // The tab ids each name resolves to, standing in for adapter.resolveTab.
  const resolver = (map: Record<string, string[]>) => (q: string) => map[q] ?? []

  test('keeps the requested order, not the bar order', () => {
    const plan = planPinnedOrder(
      ['payments', 'auth'],
      resolver({ auth: ['t-auth'], payments: ['t-pay'] }),
    )
    expect(plan.order).toEqual(['t-pay', 't-auth'])
    expect(plan.names).toEqual(['payments', 'auth'])
    expect(plan.unresolved).toEqual([])
  })

  test('reports a name that matches nothing', () => {
    const plan = planPinnedOrder(['auth', 'ghost'], resolver({ auth: ['t-auth'] }))
    expect(plan.unresolved).toEqual([{ query: 'ghost', reason: 'not-found' }])
  })

  test('reports an ambiguous name rather than picking one', () => {
    const plan = planPinnedOrder(['gap'], resolver({ gap: ['t-1', 't-2'] }))
    expect(plan.unresolved).toEqual([{ query: 'gap', reason: 'ambiguous' }])
    expect(plan.order).toEqual([])
  })

  // --first a,b,a can't mean both "a is first" and "a is third".
  test('collapses a repeated name to its first mention', () => {
    const plan = planPinnedOrder(
      ['auth', 'payments', 'auth'],
      resolver({ auth: ['t-auth'], payments: ['t-pay'] }),
    )
    expect(plan.order).toEqual(['t-auth', 't-pay'])
  })

  // Two names resolving to the same tab is the same contradiction, arriving
  // via a name and an id prefix instead of a repeat.
  test('collapses two names that resolve to the same tab', () => {
    const plan = planPinnedOrder(
      ['auth', 'aabbccdd'],
      resolver({ auth: ['t-auth'], aabbccdd: ['t-auth'] }),
    )
    expect(plan.order).toEqual(['t-auth'])
    expect(plan.names).toEqual(['auth'])
  })

  test('an empty request pins nothing', () => {
    expect(planPinnedOrder([], resolver({}))).toEqual({ order: [], names: [], unresolved: [] })
  })
})
