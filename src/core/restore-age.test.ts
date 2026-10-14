import { describe, it, expect } from 'bun:test'
import { parseAgeCutoff, suspendOlderThan } from './restore-age.js'
import type { RestoreEntry } from './restore-plan.js'

const NOW = new Date('2026-10-13T12:00:00').getTime()
const H = 3_600_000

describe('parseAgeCutoff', () => {
  it('reads durations back from now', () => {
    expect(parseAgeCutoff('90m', NOW)).toBe(NOW - 90 * 60_000)
    expect(parseAgeCutoff('12h', NOW)).toBe(NOW - 12 * H)
    expect(parseAgeCutoff('3d', NOW)).toBe(NOW - 72 * H)
    expect(parseAgeCutoff('2w', NOW)).toBe(NOW - 14 * 24 * H)
  })

  it('reads a bare date as LOCAL midnight, not UTC', () => {
    expect(parseAgeCutoff('2026-10-10', NOW)).toBe(new Date(2026, 9, 10).getTime())
    expect(parseAgeCutoff('2026-10-10 18:30', NOW)).toBe(new Date(2026, 9, 10, 18, 30).getTime())
  })

  it('refuses anything else, naming the accepted shapes', () => {
    expect(() => parseAgeCutoff('yesterday', NOW)).toThrow(/3d/)
    expect(() => parseAgeCutoff('3', NOW)).toThrow()
  })
})

describe('suspendOlderThan', () => {
  const e = (name: string, sessionId?: string, extra: Partial<RestoreEntry> = {}): RestoreEntry =>
    ({ name, dir: '/w', sessionId, ...extra })
  const activity: Record<string, number> = { recent: NOW - 1 * H, old: NOW - 100 * H }

  it('suspends what went quiet before the cutoff and keeps the rest running, in manifest order', () => {
    const r = suspendOlderThan([e('a', 'recent'), e('b', 'old')], NOW - 24 * H, (id) => activity[id])
    expect(r.entries.map((x) => [x.name, !!x.suspended])).toEqual([['a', false], ['b', true]])
    expect(r.suspended).toBe(1)
  })

  it('leaves an entry already marked suspended, and one with no session, as they are', () => {
    const r = suspendOlderThan([e('s', 'recent', { suspended: true }), e('fresh')], NOW - 24 * H, (id) => activity[id])
    expect(r.entries[0].suspended).toBe(true)
    expect(r.entries[1].suspended).toBeUndefined()
    expect(r.suspended).toBe(0)
  })

  it('does not guess when activity cannot be read — it names the entry and leaves it running', () => {
    const r = suspendOlderThan([e('x', 'missing')], NOW - 24 * H, () => undefined)
    expect(r.entries[0].suspended).toBeUndefined()
    expect(r.unknown).toEqual(['x'])
  })
})
