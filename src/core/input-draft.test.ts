import { describe, it, expect } from 'bun:test'
import { readInputDraft, draftBackoff, type ScreenRow } from './input-draft.js'

// Shapes taken from real Claude Code 2.1.300 screens rendered through a
// headless xterm 5.4.0 (Tabby's): `{…}` marks dim text in the helper below.
const RULE = '─'.repeat(100)
function row(spec: string): ScreenRow {
  let text = ''
  const dim: Array<[number, number]> = []
  for (const part of spec.split(/(\{[^}]*\})/)) {
    if (part.startsWith('{') && part.endsWith('}')) {
      const inner = part.slice(1, -1)
      dim.push([text.length, text.length + inner.length])
      text += inner
    } else text += part
  }
  return { text, dim }
}
const screen = (...specs: string[]) => specs.map(row)
const FOOTER = ['  [augmentedmind] /repo | Opus 5.5 (1M context)', '  ⏵⏵ auto mode on (shift+tab to cycle)']

describe('readInputDraft', () => {
  it('reads an empty box with its dim placeholder as empty', () => {
    expect(readInputDraft(screen(' ▐▛███▛█   Claude Code', RULE, '❯ {Try "refactor <filepath>"}', RULE, ...FOOTER)))
      .toEqual({ state: 'empty' })
  })

  it('reads a bare prompt as empty', () => {
    expect(readInputDraft(screen(RULE, '❯ ', RULE))).toEqual({ state: 'empty' })
  })

  it('finds a typed draft', () => {
    expect(readInputDraft(screen(RULE, '❯ half written thought about bananas', RULE, ...FOOTER)))
      .toEqual({ state: 'draft', text: 'half written thought about bananas' })
  })

  it('reads a multi-line draft down to the closing rule', () => {
    expect(readInputDraft(screen(RULE, '❯ line one', '  line two', RULE)))
      .toEqual({ state: 'draft', text: 'line one\nline two' })
  })

  it('counts a collapsed paste as a draft', () => {
    expect(readInputDraft(screen(RULE, '❯ [Pasted text #1 +11 lines]', RULE)).state).toBe('draft')
  })

  it('takes the live box, not a submitted message higher up', () => {
    // Mid-turn: the submitted prompt still shows `❯` but has no rule above it.
    const s = screen('❯ run the bash command sleep 20', '⏺ Bash(sleep 20)', RULE, '❯ typed while busy', RULE)
    expect(readInputDraft(s)).toEqual({ state: 'draft', text: 'typed while busy' })
    const idle = screen('❯ run the bash command sleep 20', '⏺ Bash(sleep 20)', RULE, '❯ {Try "fix lint errors"}', RULE)
    expect(readInputDraft(idle)).toEqual({ state: 'empty' })
  })

  it('accepts a top rule that carries the session name', () => {
    expect(readInputDraft(screen(`${'─'.repeat(80)} my-tab ─`, '❯ draft', RULE)).state).toBe('draft')
  })

  it('is unknown for a picker, so a digit can still be sent to it', () => {
    // /model: `❯` marks the selected option and there is no input box.
    const s = screen('❯ /model', RULE, '  Select model', '    1.  Default (recommended)', '  ❯ 2.  Opus 5.5 ✔', '  Enter to set as default · Esc to cancel')
    expect(readInputDraft(s).state).toBe('unknown')
    // And a picker drawn straight under a rule is still not a draft.
    expect(readInputDraft(screen(RULE, '❯ 1. Yes, I trust this folder', '  2. No, exit', RULE)).state).toBe('unknown')
  })

  it('is unknown for a shell, or a box cut off at the bottom', () => {
    expect(readInputDraft(screen('motin@mbp ~ %')).state).toBe('unknown')
    expect(readInputDraft(screen(RULE, '❯ cut off')).state).toBe('unknown')
    expect(readInputDraft([]).state).toBe('unknown')
  })
})

describe('draftBackoff', () => {
  it('doubles from 1s, caps at 16s, and never exceeds the total', () => {
    expect(draftBackoff(60_000)).toEqual([1000, 2000, 4000, 8000, 16000, 16000, 13000])
  })
  it('is empty for a zero wait', () => {
    expect(draftBackoff(0)).toEqual([])
  })
})
