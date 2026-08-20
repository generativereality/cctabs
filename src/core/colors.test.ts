import { describe, it, expect, beforeEach } from 'bun:test'
import type { TerminalAdapter } from './adapter.js'
import {
  CAP_TAB_COLOR,
  TAB_COLORS,
  applyTabColor,
  resolveColorPreference,
  resolveTabColor,
  resetTabColorWarning,
} from './colors.js'

describe('resolveTabColor', () => {
  it('maps a palette name to the exact hex Tabby uses', () => {
    // Not just "a blue": Tabby's right-click → Color menu ticks its radio by
    // comparing tab.color against these literals, so any other blue would make
    // a cctabs-set colour look unlike a hand-set one.
    expect(resolveTabColor('blue')).toBe('#0275d8')
    expect(resolveTabColor('green')).toBe('#5cb85c')
    expect(resolveTabColor('orange')).toBe('#f0ad4e')
    expect(resolveTabColor('purple')).toBe('#613d7c')
    expect(resolveTabColor('red')).toBe('#d9534f')
    expect(resolveTabColor('yellow')).toBe('#ffd500')
  })

  it('is case- and whitespace-insensitive on names', () => {
    expect(resolveTabColor('  BLUE ')).toBe('#0275d8')
  })

  it('accepts 3-, 6- and 8-digit hex, normalised to lowercase', () => {
    expect(resolveTabColor('#08D')).toBe('#08d')
    expect(resolveTabColor('#0275D8')).toBe('#0275d8')
    expect(resolveTabColor('#0275d8FF')).toBe('#0275d8ff')
  })

  it('treats none/default/empty as "clear the colour"', () => {
    expect(resolveTabColor('none')).toBeNull()
    expect(resolveTabColor('no-color')).toBeNull()
    expect(resolveTabColor('default')).toBeNull()
    expect(resolveTabColor('')).toBeNull()
  })

  it('rejects an unknown colour rather than silently doing nothing', () => {
    // Tabby binds the value straight into [style.background-color], so a bogus
    // colour would just fail to render with no error anywhere.
    expect(() => resolveTabColor('chartreuse')).toThrow(/Unknown color "chartreuse"/)
    expect(() => resolveTabColor('#12345')).toThrow(/Unknown color/)
    expect(() => resolveTabColor('rgb(1,2,3)')).toThrow(/Unknown color/)
  })

  it('names every palette entry in the error message', () => {
    expect(() => resolveTabColor('nope')).toThrow(/blue, green, orange, purple, red, yellow, none/)
  })
})

describe('resolveColorPreference', () => {
  it('prefers an explicit --color over both defaults', () => {
    expect(resolveColorPreference('red', 'blue', 'green')).toBe(TAB_COLORS.red)
  })

  it('falls back to the backend preset colour', () => {
    expect(resolveColorPreference(undefined, 'blue', 'green')).toBe(TAB_COLORS.blue)
  })

  it('falls back to [defaults] color last', () => {
    expect(resolveColorPreference(undefined, undefined, 'green')).toBe(TAB_COLORS.green)
  })

  it('returns undefined when nothing is configured, so no colour call is made', () => {
    // undefined ("don't touch") must stay distinct from null ("clear it") —
    // otherwise every uncoloured tab would cost a capability probe and would
    // clear colours a user set by hand.
    expect(resolveColorPreference(undefined, undefined, undefined)).toBeUndefined()
    expect(resolveColorPreference(undefined, undefined, '')).toBeUndefined()
  })

  it('lets an explicit "none" clear a configured default', () => {
    expect(resolveColorPreference('none', 'blue', 'green')).toBeNull()
  })

  it('propagates the validation error from the config-supplied value', () => {
    expect(() => resolveColorPreference(undefined, undefined, 'puce')).toThrow(/Unknown color "puce"/)
  })
})

/** Minimal adapter double — only the two members applyTabColor touches. */
function fakeAdapter(caps: string[], sink: Array<string | null>): TerminalAdapter {
  return {
    backendCapabilities: async () => caps,
    setTabColor: async (_tabId: string, color: string | null) => { sink.push(color) },
  } as unknown as TerminalAdapter
}

describe('applyTabColor', () => {
  beforeEach(resetTabColorWarning)

  it('applies the colour when the plugin advertises tab-color', async () => {
    const sink: Array<string | null> = []
    const applied = await applyTabColor(fakeAdapter([CAP_TAB_COLOR], sink), 'uuid-1', '#0275d8')
    expect(applied).toBe(true)
    expect(sink).toEqual(['#0275d8'])
  })

  it('degrades instead of throwing against a plugin without the capability', async () => {
    // A user's installed plugin is routinely older than their CLI. Losing the
    // spawn over a cosmetic field would be much the worse outcome.
    const sink: Array<string | null> = []
    const applied = await applyTabColor(fakeAdapter(['spawn-waits-for-pty'], sink), 'uuid-1', '#0275d8')
    expect(applied).toBe(false)
    expect(sink).toEqual([])
  })

  it('degrades when the adapter has no notion of colours at all', async () => {
    const applied = await applyTabColor({} as TerminalAdapter, 'uuid-1', '#0275d8')
    expect(applied).toBe(false)
  })

  it('passes null through to clear a colour', async () => {
    const sink: Array<string | null> = []
    await applyTabColor(fakeAdapter([CAP_TAB_COLOR], sink), 'uuid-1', null)
    expect(sink).toEqual([null])
  })
})
