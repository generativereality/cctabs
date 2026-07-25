import { describe, expect, test } from 'bun:test'
import { rankTabsByActivity } from './sort.js'

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
