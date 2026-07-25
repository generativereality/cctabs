import { describe, it, expect } from 'bun:test'
import { matchTabsByName, normalizeTabName } from './tab-match.js'

const TABS = new Map<string, string>([
  ['aaaaaaaa-1111', 'gapminder'],
  ['bbbbbbbb-2222', 'gapminder-login'],
  ['cccccccc-3333', 'Portfolio'],
])
const IDS = [...TABS.keys()]

describe('matchTabsByName', () => {
  it('prefers an exact name match over a longer prefix match', () => {
    expect(matchTabsByName('gapminder', IDS, TABS)).toEqual(['aaaaaaaa-1111'])
  })

  it('matches names case-insensitively', () => {
    expect(matchTabsByName('portfolio', IDS, TABS)).toEqual(['cccccccc-3333'])
  })

  it('falls back to name prefixes when nothing matches exactly', () => {
    expect(matchTabsByName('gapm', IDS, TABS)).toEqual(['aaaaaaaa-1111', 'bbbbbbbb-2222'])
  })

  it('falls back to id prefixes', () => {
    expect(matchTabsByName('cccccccc', IDS, TABS)).toEqual(['cccccccc-3333'])
  })

  describe('exact mode', () => {
    it('still returns the exact name match', () => {
      expect(matchTabsByName('gapminder', IDS, TABS, { exact: true })).toEqual(['aaaaaaaa-1111'])
    })

    // The regression: resuming "gapminder" prefix-matched the unrelated live
    // "gapminder-login" tab, so restore/resume concluded the session was
    // already running and skipped it.
    it('does not match a longer-named tab by prefix', () => {
      const stale = new Map<string, string>([['bbbbbbbb-2222', 'gapminder-login']])
      expect(matchTabsByName('gapminder', ['bbbbbbbb-2222'], stale, { exact: true })).toEqual([])
    })

    it('does not match a name prefix', () => {
      expect(matchTabsByName('gapm', IDS, TABS, { exact: true })).toEqual([])
    })

    it('does not match an id prefix, but does match a full id', () => {
      expect(matchTabsByName('cccccccc', IDS, TABS, { exact: true })).toEqual([])
      expect(matchTabsByName('cccccccc-3333', IDS, TABS, { exact: true })).toEqual(['cccccccc-3333'])
    })
  })

  it('returns every tab sharing an exact name', () => {
    const dupes = new Map<string, string>([
      ['t1', 'notes'],
      ['t2', 'notes'],
      ['t3', 'other'],
    ])
    expect(matchTabsByName('notes', [...dupes.keys()], dupes, { exact: true })).toEqual(['t1', 't2'])
  })
})

describe('normalizeTabName', () => {
  it("strips Claude Code's working glyph so a busy tab keeps its identity", () => {
    expect(normalizeTabName('✳ career-strategy')).toBe('career-strategy')
    expect(normalizeTabName('✻ career-strategy')).toBe('career-strategy')
  })

  it('leaves an ordinary title untouched', () => {
    expect(normalizeTabName('career-strategy')).toBe('career-strategy')
    expect(normalizeTabName('OS default')).toBe('OS default')
  })

  it('keeps punctuation that is part of the name, not a status marker', () => {
    // No space after the leading run, so it is not a marker.
    expect(normalizeTabName('~/Remember This')).toBe('~/Remember This')
    expect(normalizeTabName('@scope/pkg — build')).toBe('@scope/pkg — build')
  })

  it('does not eat a long symbol run or an all-symbol title', () => {
    expect(normalizeTabName('>>>> deploy')).toBe('>>>> deploy')
    expect(normalizeTabName('✳')).toBe('✳')
  })
})
