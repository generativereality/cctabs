import { describe, it, expect } from 'bun:test'
import { confirmResumePicker, sendTextWithConfirmation } from './open-session.js'
import type { TerminalAdapter } from './adapter.js'

// The literal screens each state renders. Whitespace is irrelevant to the
// detectors (they strip it), but we keep realistic spacing to mirror what
// Tabby's scrollback actually returns.
const SCREENS: Record<string, string> = {
  picker:
    '❯ 1. Resume from summary (recommended)\n' +
    '  2. Resume full session as-is\n' +
    "  3. Don't ask me again",
  rcOverlay:
    'Continue coding in the Claude mobile app or https://claude.ai/code/abc123' +
    ' — d to disconnect · space for QR · Enter/Esc to close',
  clean: '❯ Try "edit a file"                        auto mode',
}

const DOWN = '\x1b[B'
const ENTER = '\r'
const ESC = '\x1b'

/**
 * A scriptable mock adapter driven by a tiny state machine. `initial` is the
 * starting screen; `on[state][input]` names the screen to advance to when that
 * exact input is sent (unmatched inputs leave the state unchanged). Only
 * scrollback + sendInput are exercised by confirmResumePicker, so the rest of
 * TerminalAdapter is filled by the cast.
 */
function mockAdapter(script: {
  initial: string
  on?: Record<string, Record<string, string>>
}): { adapter: TerminalAdapter; inputs: string[]; state: () => string } {
  let state = script.initial
  const inputs: string[] = []
  const adapter = {
    scrollback: (_blockId: string, _lastN?: number) => SCREENS[state],
    sendInput: async (_blockId: string, text: string) => {
      inputs.push(text)
      const next = script.on?.[state]?.[text]
      if (next) state = next
      return undefined
    },
  } as unknown as TerminalAdapter
  return { adapter, inputs, state: () => state }
}

// No real waiting: inject an instant sleep so the poll loops iterate against
// the mock's current screen without burning wall-clock.
const NO_SLEEP = { sleep: async (_ms: number) => {} }

describe('confirmResumePicker', () => {
  it('selects "full session", then dismisses the follow-up mobile-app overlay', async () => {
    // picker --Enter--> session loads showing the RC overlay --Esc--> clean
    const { adapter, inputs, state } = mockAdapter({
      initial: 'picker',
      on: {
        picker: { [ENTER]: 'rcOverlay' },
        rcOverlay: { [ESC]: 'clean' },
      },
    })

    await confirmResumePicker(adapter, 'b1', NO_SLEEP)

    // ↓ sent exactly once (never risk landing on option 3).
    expect(inputs.filter((i) => i === DOWN)).toHaveLength(1)
    expect(inputs).toContain(ENTER)
    expect(inputs).toContain(ESC)
    // ↓ precedes the first Enter (moves highlight to option 2 before confirm).
    expect(inputs.indexOf(DOWN)).toBeLessThan(inputs.indexOf(ENTER))
    expect(state()).toBe('clean')
  })

  it('handles a picker with no follow-up overlay', async () => {
    const { adapter, inputs, state } = mockAdapter({
      initial: 'picker',
      on: { picker: { [ENTER]: 'clean' } },
    })

    await confirmResumePicker(adapter, 'b1', NO_SLEEP)

    expect(inputs.filter((i) => i === DOWN)).toHaveLength(1)
    expect(inputs).toContain(ENTER)
    expect(inputs).not.toContain(ESC) // no overlay → nothing to Esc
    expect(state()).toBe('clean')
  })

  it('sends no keys when the session resumes directly without a picker', async () => {
    // Adaptive early-exit: the loaded footer proves no picker is coming, so we
    // must not press ↓/Enter into a live session (which could corrupt input or,
    // worse, hit option 3 if a picker raced in).
    const { adapter, inputs } = mockAdapter({ initial: 'clean' })

    await confirmResumePicker(adapter, 'b1', NO_SLEEP)

    expect(inputs).toHaveLength(0)
  })

  it('dismisses the mobile-app overlay on a direct resume (no picker)', async () => {
    const { adapter, inputs, state } = mockAdapter({
      initial: 'rcOverlay',
      on: { rcOverlay: { [ESC]: 'clean' } },
    })

    await confirmResumePicker(adapter, 'b1', NO_SLEEP)

    expect(inputs).not.toContain(DOWN) // never touched the picker
    expect(inputs.filter((i) => i === ESC).length).toBeGreaterThanOrEqual(1)
    expect(state()).toBe('clean')
  })
})

/**
 * A scriptable mock whose `scrollback` echoes back whatever the last non-clear
 * `sendInput` call carried, optionally clipped — so tests can simulate the
 * front-clipped-send failure mode directly instead of a generic state machine.
 */
function echoAdapter(clipFirstN: number[]): { adapter: TerminalAdapter; inputs: string[] } {
  const inputs: string[] = []
  let screen = ''
  let realSendCount = 0
  const adapter = {
    sendInput: async (_blockId: string, text: string) => {
      inputs.push(text)
      if (text === '\x15') { screen = ''; return undefined }
      const clip = clipFirstN[realSendCount] ?? 0
      realSendCount++
      screen = text.slice(clip)
      return undefined
    },
    scrollback: (_blockId: string, _lastN?: number) => screen,
  } as unknown as TerminalAdapter
  return { adapter, inputs }
}

describe('sendTextWithConfirmation', () => {
  const TEXT = 'hello from tab-a: do the thing'

  it('confirms on the first send when the text lands intact', async () => {
    const { adapter, inputs } = echoAdapter([0])

    const ok = await sendTextWithConfirmation(adapter, 'b1', TEXT, { sleep: async () => {} })

    expect(ok).toBe(true)
    expect(inputs).toEqual([TEXT]) // no retry needed
  })

  it('detects a front-clipped send and retries until the full text lands', async () => {
    const { adapter, inputs } = echoAdapter([10, 0]) // first send drops its front, second lands whole

    const ok = await sendTextWithConfirmation(adapter, 'b1', TEXT, { sleep: async () => {} })

    expect(ok).toBe(true)
    expect(inputs).toEqual([TEXT, '\x15', TEXT]) // cleared before the re-send, never stacked
  })

  it('wraps the payload in bracketed-paste markers when asked', async () => {
    const { adapter, inputs } = echoAdapter([0])

    await sendTextWithConfirmation(adapter, 'b1', TEXT, { sleep: async () => {}, bracketedPaste: true })

    expect(inputs).toEqual([`\x1b[200~${TEXT}\x1b[201~`])
  })

  it('sends short text once, unconfirmed, without retrying', async () => {
    const { adapter, inputs } = echoAdapter([]) // scrollback never shows anything landed

    const ok = await sendTextWithConfirmation(adapter, 'b1', 'y', { sleep: async () => {} })

    expect(ok).toBe(true)
    expect(inputs).toEqual(['y'])
  })

  it('gives up and reports false after exhausting retries', async () => {
    const adapter = {
      sendInput: async () => undefined,
      scrollback: () => '', // never lands
    } as unknown as TerminalAdapter

    const ok = await sendTextWithConfirmation(adapter, 'b1', TEXT, {
      sleep: async () => {},
      attempts: 2,
      pollCount: 2,
    })

    expect(ok).toBe(false)
  })
})
