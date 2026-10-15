import { describe, it, expect } from 'bun:test'
import { confirmResumePicker, sendTextWithConfirmation, readTab, clearStartupDialogs } from './open-session.js'
import type { TerminalAdapter } from './adapter.js'
import { bypassAcceptVisible } from './session-status.js'

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

    expect(ok.landed).toBe(true)
    expect(inputs).toEqual([TEXT]) // no retry needed
  })

  it('detects a front-clipped send and retries until the full text lands', async () => {
    const { adapter, inputs } = echoAdapter([10, 0]) // first send drops its front, second lands whole

    const ok = await sendTextWithConfirmation(adapter, 'b1', TEXT, { sleep: async () => {} })

    expect(ok.landed).toBe(true)
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

    expect(ok.landed).toBe(true)
    // Reported as unchecked, so a caller can't present it as verified.
    expect(ok.unchecked).toBe(true)
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

    expect(ok.landed).toBe(false)
    expect(ok.confirmed).toBe(false)
    expect(ok.detail).toContain('nothing from the text appeared')
  })

  // A collapsed paste is landed but unconfirmed, and that gap is the point:
  // measured, a 6,892-byte payload delivered COMPLETELY into an idle tab while
  // its chip read "+10 lines", so a short chip cannot be treated as truncation
  // — but nor can the chip's presence be treated as proof of completeness.
  it('reports a collapsed paste as landed without claiming it is complete', async () => {
    const big = Array.from({ length: 120 }, (_, i) => `line ${i} of the brief`).join('\n')
    const adapter = {
      sendInput: async () => undefined,
      scrollback: () => '[Pasted text #1 +10 lines]',
    } as unknown as TerminalAdapter

    const verdict = await sendTextWithConfirmation(adapter, 'b1', big, {
      sleep: async () => {}, attempts: 1, pollCount: 1,
    })

    expect(verdict.landed).toBe(true)
    expect(verdict.confirmed).toBe(false)
    expect(verdict.detail).toContain('unverified')
  })

  it('confirms a paste it can actually see echoed', async () => {
    const { adapter } = echoAdapter([0])
    const verdict = await sendTextWithConfirmation(adapter, 'b1', TEXT, { sleep: async () => {} })
    expect(verdict.confirmed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The folder-trust dialog. Current Claude Code lists "No, exit" FIRST and
// highlighted, so the old bare-Enter answer quit the session.

import { answerTrustDialog } from './open-session.js'

/** A trust dialog whose cursor moves with ↓/↑ and which clears on Enter-on-Yes. */
function trustAdapter(layout: 'no-first' | 'yes-first', opts: { dropArrows?: boolean; hideCursor?: boolean; unnumbered?: boolean } = {}) {
  const options = layout === 'no-first' ? ['No, exit', 'Yes, I trust this folder'] : ['Yes, I trust this folder', 'No, exit']
  let cursor = 0
  let outcome: 'pending' | 'trusted' | 'exited' = 'pending'
  const inputs: string[] = []
  const render = () => {
    if (outcome === 'trusted') return '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'
    if (outcome === 'exited') return 'motin@host ~ %'
    return 'Quick safety check: Is this a project you created or one you trust?\n' +
      options.map((o, i) => `${!opts.hideCursor && i === cursor ? '❯' : ' '} ${opts.unnumbered ? '' : `${i + 1}. `}${o}`).join('\n')
  }
  const adapter = {
    scrollback: () => render(),
    sendInput: async (_b: string, text: string) => {
      inputs.push(text)
      if (outcome !== 'pending') return
      if (text === DOWN && !opts.dropArrows) cursor = Math.min(cursor + 1, options.length - 1)
      if (text === '\x1b[A' && !opts.dropArrows) cursor = Math.max(cursor - 1, 0)
      if (text === ENTER) outcome = options[cursor].startsWith('Yes') ? 'trusted' : 'exited'
    },
  } as unknown as TerminalAdapter
  return { adapter, inputs, outcome: () => outcome }
}

describe('answerTrustDialog', () => {
  it('moves to "Yes" before pressing Enter when "No, exit" is first and highlighted', async () => {
    const t = trustAdapter('no-first')
    expect(await answerTrustDialog(t.adapter, 'b', NO_SLEEP)).toBe(true)
    expect(t.outcome()).toBe('trusted')
    expect(t.inputs).toEqual([DOWN, ENTER])
  })

  it('does the same on the live layout, which draws no option numbers', async () => {
    const t = trustAdapter('no-first', { unnumbered: true })
    expect(await answerTrustDialog(t.adapter, 'b', NO_SLEEP)).toBe(true)
    expect(t.outcome()).toBe('trusted')
    expect(t.inputs).toEqual([DOWN, ENTER])
  })

  it('presses Enter directly on the older Yes-first layout', async () => {
    const t = trustAdapter('yes-first')
    expect(await answerTrustDialog(t.adapter, 'b', NO_SLEEP)).toBe(true)
    expect(t.outcome()).toBe('trusted')
    expect(t.inputs).toEqual([ENTER])
  })

  it('never presses Enter when the ↓ did not visibly land', async () => {
    const t = trustAdapter('no-first', { dropArrows: true })
    expect(await answerTrustDialog(t.adapter, 'b', NO_SLEEP)).toBe(false)
    expect(t.inputs).not.toContain(ENTER)
    expect(t.outcome()).toBe('pending')
  })

  it('never presses Enter when the cursor cannot be read at all', async () => {
    const t = trustAdapter('no-first', { hideCursor: true })
    expect(await answerTrustDialog(t.adapter, 'b', NO_SLEEP)).toBe(false)
    expect(t.inputs).toEqual([])
  })
})

describe('dialogs read off the screen (Windows)', () => {
  it('answers the trust dialog from the screen when the stream shows no cursor', async () => {
    // Windows: ConPTY repaints the dialog in fragments, so the output stream
    // never shows which option is highlighted, and the dialog was left open.
    // The screen shows it.
    const options = ['No, exit', 'Yes, I trust this folder']
    let cursor = 0
    let outcome: 'pending' | 'trusted' | 'exited' = 'pending'
    const inputs: string[] = []
    const body = (glyph: boolean) => outcome === 'trusted'
      ? '⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'
      : 'Quick safety check: Is this a project you created or one you trust?\n' +
        options.map((o, i) => `${glyph && i === cursor ? '❯' : ' '} ${o}`).join('\n')
    const a = {
      scrollback: () => body(false),
      screenText: async () => body(true),
      sendInput: async (_b: string, t: string) => {
        inputs.push(t)
        if (t === DOWN) cursor = Math.min(cursor + 1, 1)
        if (t === ENTER) outcome = options[cursor].startsWith('Yes') ? 'trusted' : 'exited'
      },
    } as unknown as TerminalAdapter
    expect(await answerTrustDialog(a, 'b', NO_SLEEP)).toBe(true)
    expect(outcome as string).toBe('trusted')
    expect(inputs).toEqual([DOWN, ENTER])
  })

  it('readTab prefers the screen and falls back to the stream', async () => {
    const a = { scrollback: () => 'stream', screenText: async () => 'screen' } as unknown as TerminalAdapter
    expect(await readTab(a, 'b', 10)).toBe('screen')
    const old = { scrollback: () => 'stream', screenText: async () => null } as unknown as TerminalAdapter
    expect(await readTab(old, 'b', 10)).toBe('stream')
    const none = { scrollback: () => 'stream' } as unknown as TerminalAdapter
    expect(await readTab(none, 'b', 10)).toBe('stream')
  })
})

describe('the Bypass Permissions acceptance', () => {
  const BYPASS = 'WARNING: Claude Code running in Bypass Permissions mode\n' +
    'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.\n' +
    '❯ No, exit\n  Yes, I accept\nEnter to confirm · Esc to cancel'

  it('is recognised', () => {
    expect(bypassAcceptVisible(BYPASS)).toBe(true)
    expect(bypassAcceptVisible('❯ Try "edit a file"   auto mode')).toBe(false)
  })

  it('is never answered: clearStartupDialogs types nothing and reports it open', async () => {
    const inputs: string[] = []
    const a = { scrollback: () => BYPASS, sendInput: async (_b: string, t: string) => { inputs.push(t) } } as unknown as TerminalAdapter
    expect(await clearStartupDialogs(a, 'b', { trusted: true, ...NO_SLEEP })).toBe(false)
    expect(inputs).toEqual([])
  })
})

describe('trust, then the bypass acceptance (a fresh machine)', () => {
  it('answers trust, then stops at bypass with a message about bypass — Claude left running', async () => {
    let stage: 'trust' | 'bypass' = 'trust'
    let cursor = 0
    const inputs: string[] = []
    const screen = () => stage === 'trust'
      ? `Quick safety check\n${cursor === 0 ? '❯' : ' '} No, exit\n${cursor === 1 ? '❯' : ' '} Yes, I trust this folder`
      : 'WARNING: Claude Code running in Bypass Permissions mode\n❯ No, exit\n  Yes, I accept'
    const a = {
      scrollback: () => screen(),
      sendInput: async (_b: string, t: string) => {
        inputs.push(t)
        if (stage === 'trust' && t === DOWN) cursor = 1
        if (stage === 'trust' && t === ENTER && cursor === 1) stage = 'bypass'
      },
    } as unknown as TerminalAdapter
    expect(await clearStartupDialogs(a, 'b', { trusted: true, ...NO_SLEEP })).toBe(false)
    expect(stage as string).toBe('bypass')
    expect(inputs).toEqual([DOWN, ENTER]) // nothing typed at the bypass dialog
  })
})
