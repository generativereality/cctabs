import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { detectTerminal, resolveTerminal } from './terminal.js'

// Env keys detectTerminal()/resolveTerminal() read. We snapshot + wipe them
// before each test so the host's real terminal doesn't leak into assertions.
const ENV_KEYS = [
  'CCTABS_TERMINAL',
  'CCTABS_BACKEND',
  'TERM_PROGRAM',
  'TERM',
  'WAVETERM_JWT',
  'GHOSTTY_RESOURCES_DIR',
  'KITTY_WINDOW_ID',
  'CCTABS_TABBY_HOST',
  'CCTABS_TABBY_PORT',
]

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('detectTerminal override', () => {
  it('honours CCTABS_TERMINAL before any env sniffing', () => {
    process.env.TERM_PROGRAM = 'iTerm.app'
    process.env.CCTABS_TERMINAL = 'tabby'
    expect(detectTerminal()).toBe('tabby')
  })

  it('accepts CCTABS_BACKEND as an alias', () => {
    process.env.CCTABS_BACKEND = 'tabby'
    expect(detectTerminal()).toBe('tabby')
  })

  // Wave's adapter was removed in 0.5.0, but detection deliberately survives it:
  // requireAdapter() needs to tell a Wave user that support was *withdrawn*
  // rather than report "an unrecognised terminal", which would read as a bug.
  it('still recognises Wave, so the withdrawal message can be specific', () => {
    process.env.WAVETERM_JWT = 'stub-jwt'
    expect(detectTerminal()).toBe('wave')
  })

  it('is case- and whitespace-insensitive', () => {
    process.env.CCTABS_TERMINAL = '  Tabby  '
    expect(detectTerminal()).toBe('tabby')
  })

  it('ignores an unrecognised override value and falls back to sniffing', () => {
    process.env.CCTABS_TERMINAL = 'nonsense'
    process.env.TERM_PROGRAM = 'iTerm.app'
    expect(detectTerminal()).toBe('iterm2')
  })

  it('returns unknown when nothing identifies the terminal', () => {
    expect(detectTerminal()).toBe('unknown')
  })
})

describe('resolveTerminal probe fallback', () => {
  it('does not probe when the terminal is already known', () => {
    process.env.TERM_PROGRAM = 'Tabby'
    // Point the probe at a dead port; a known terminal must not depend on it.
    process.env.CCTABS_TABBY_PORT = '59999'
    expect(resolveTerminal()).toBe('tabby')
  })

  it('stays unknown when unrecognised and no plugin answers', () => {
    process.env.CCTABS_TABBY_PORT = '59999' // nothing listening here
    expect(resolveTerminal()).toBe('unknown')
  })
})
