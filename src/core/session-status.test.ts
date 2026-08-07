import { describe, expect, it } from 'bun:test'
import { classifyTerminalBuffer, parsePermissionMode, toLaunchableMode } from './session-status.js'

/**
 * Fixtures are trimmed captures from a real 59-tab fleet, taken through the
 * Tabby plugin's own `/api/tabs/:id/buffer` endpoint — including its habit of
 * dropping the spaces between adjacent characters.
 */

/** A long-context session sitting at an empty prompt. This is what idle looks like. */
const IDLE_TAIL = `
⏵⏵automodeon (shift+tabtocycle)·←foragents
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
Checking for updates/rc
/rc
`

/** Mid-turn: spinner glyphs and an elapsed-time label dominate the tail. */
const BUSY_TAIL = `
⏺Bash(cd /tmp&&python3-<<'EOF' import json,…)  ⎿  Running…
✽ Dilly-dallying… (14m 5s · ↓34.9k tokens)
~/Dev/Projects/generativereality/cctabs|Opus5(1Mcontext)|ctx:11%|5h:2%7d:42%/rc
⏵⏵bypasspermissionson ·1shell ·←foragents
Dilly-dallying…
✻Dilly-dallying…
`

/** The turn just ended. A glyph is present but the session is waiting again. */
const JUST_FINISHED_TAIL = `
Ithendidtheotherthing.
✻Bakedfor47s
※recap:Goalwascheckingwhethercctabssortworks
`

describe('classifyTerminalBuffer', () => {
  it('reports an empty capture as unreadable, never as a bare terminal', () => {
    expect(classifyTerminalBuffer('')).toBe('unreadable')
    expect(classifyTerminalBuffer('   \n\n  \n')).toBe('unreadable')
  })

  it('reports a session at its prompt as idle, not active', () => {
    expect(classifyTerminalBuffer(IDLE_TAIL)).toBe('idle')
  })

  it('reports a session with a turn in flight as active', () => {
    expect(classifyTerminalBuffer(BUSY_TAIL)).toBe('active')
  })

  it('does not call a just-finished turn active — a completion notice carries a spinner glyph too', () => {
    expect(classifyTerminalBuffer(JUST_FINISHED_TAIL)).toBe('idle')
  })

  it('recognises a completion notice by its shape, not by its verb', () => {
    // Claude's verb vocabulary is open-ended: an enumerated list shipped here
    // and missed `Sautéed for` on the first real fleet it was run against.
    for (const verb of ['Sautéed', 'Baked', 'Worked', 'Effervescing', 'Whatever']) {
      expect(classifyTerminalBuffer(`✻${verb} for 4m 1s`)).toBe('idle')
    }
  })

  it('still calls a spinner with an elapsed-time readout active', () => {
    // The in-flight line carries a duration too — but never the word "for".
    expect(classifyTerminalBuffer('✽ Dilly-dallying… (14m 5s · ↓34.9k tokens)')).toBe('active')
  })

  it('does not treat permanent chrome as evidence of work in flight', () => {
    // Every one of these is on screen for the life of a session. Matching any
    // of them as "active" is what collapsed the whole fleet into one state.
    for (const chrome of [
      'Claude Code v2.0',
      'https://claude.ai/code',
      '⏵⏵ bypass permissions on',
      '⏵⏵ auto mode on (shift+tab to cycle)',
      'new task? /clear to save 304.6k tokens',
      'Checking for updates',
    ]) {
      expect(classifyTerminalBuffer(chrome)).toBe('idle')
    }
  })

  it('reports a bare shell as terminal even while Claude UI lingers in the buffer', () => {
    // The buffer keeps everything the tab ever emitted, so a session that has
    // exited leaves its chrome behind. The live prompt is what counts.
    const exited = `${IDLE_TAIL}\nmotin@mbp cctabs %`
    expect(classifyTerminalBuffer(exited)).toBe('terminal')
  })

  it('ignores a stale spinner far above the live tail', () => {
    // The buffer accumulates; it is not a viewport. A glyph 40 redraws ago
    // proves the session was busy then, not now.
    const stale = `✻ Thinking…\n⏵⏵ auto mode on\n${'/rc\n'.repeat(40)}`
    expect(classifyTerminalBuffer(stale)).toBe('idle')
  })

  it('matches markers through the plugin dropping spaces between characters', () => {
    expect(classifyTerminalBuffer('⏵⏵automodeon (shift+tabtocycle)')).toBe('idle')
  })
})

describe('parsePermissionMode', () => {
  // Footer text as the plugin's buffer actually delivers it, spaces and all.
  const PILLS: Array<[string, string]> = [
    ['⏵⏵automodeon (shift+tabtocycle)·←foragents', 'auto'],
    ['⏵⏵ accept edits on (shift+tab to cycle) · ← for agents', 'acceptEdits'],
    ['⏸ plan mode on (shift+tab to cycle) · ← for agents', 'plan'],
    ['⏵⏵bypasspermissionson ·1shell ·←foragents', 'bypassPermissions'],
    ['⏸ manual mode on · ← for agents', 'manual'],
  ]

  for (const [pill, expected] of PILLS) {
    it(`reads ${expected} from its footer`, () => {
      expect(parsePermissionMode(pill)).toBe(expected as never)
    })
  }

  it('takes the most recent pill, since the buffer keeps every redraw', () => {
    // Cycling shift+tab leaves the old pills above the new one.
    const cycled = [
      '⏵⏵ auto mode on',
      '⏸ manual mode on',
      '⏸ plan mode on',
    ].join('\n')
    expect(parsePermissionMode(cycled)).toBe('plan')
  })

  it('returns nothing when there is no footer to read', () => {
    expect(parsePermissionMode('')).toBeUndefined()
    expect(parsePermissionMode('motin@mbp cctabs %')).toBeUndefined()
  })
})

describe('toLaunchableMode', () => {
  it('accepts every mode claude --permission-mode takes', () => {
    for (const m of ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'plan']) {
      expect(toLaunchableMode(m)).toBe(m as never)
    }
  })

  it('drops "default", which real transcripts contain and the flag rejects', () => {
    // Passing it through would make the relaunch fail outright rather than
    // fall back to the configured flags.
    expect(toLaunchableMode('default')).toBeUndefined()
  })

  it('drops anything else, including non-strings', () => {
    for (const v of ['dontAsk', 'PLAN', '', undefined, null, 7, {}]) {
      expect(toLaunchableMode(v)).toBeUndefined()
    }
  })
})
