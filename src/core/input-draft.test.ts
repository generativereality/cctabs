import { describe, it, expect } from 'bun:test'
import { readInputDraft, draftBackoff, markSuggestion, type ScreenRow } from './input-draft.js'

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

describe('readInputDraft — Codex', () => {
  const FOOT = '  ← for agents · ? for shortcuts'
  it('reads an empty Codex box (dim placeholder) as empty', () => {
    expect(readInputDraft(screen('› {reply with just: ready}', '• ready', '› {Ask Codex to do anything}', '  GPT default · /tmp', FOOT)))
      .toEqual({ state: 'empty' })
  })
  it('finds a draft in the Codex box, not the submitted prompt above it', () => {
    expect(readInputDraft(screen('› {reply with just: ready}', '• ready', '› half a thought', '  GPT default · /tmp', FOOT)))
      .toEqual({ state: 'draft', text: 'half a thought' })
  })
})

describe('readInputDraft — Codex while typing', () => {
  it('finds the draft though Codex hides its footer while you type', () => {
    // Real screen, Codex 0.162.1: the "? for shortcuts" line goes blank.
    const rows = screen(
      '{› }reply with just: ok', '{• }ok', '{  Worked for 2s • 20:12}',
      '› half written thought', '', '  GPT-6.1-Sol default · /tmp/x', '                    ',
    )
    expect(readInputDraft(rows)).toEqual({ state: 'draft', text: 'half written thought' })
  })
  it('does not read a shell prompt drawn with › as a Codex box', () => {
    expect(readInputDraft(screen('motin › ls', 'a b c', 'motin › ')).state).toBe('unknown')
  })
})

// Claude Code's prompt suggestion — the guess at your next message that Tab
// accepts — is drawn as the input's placeholder: dim, and only while the box
// is empty (Claude Code 2.1.312). Typing over it replaces it; a real 2.1.312
// screen through xterm 5.4.0 after typing `hello` over the placeholder:
const TYPED_OVER = [RULE, '❯ hello', RULE]
const PLACEHOLDER_BEFORE = [RULE, '❯ {Try "write a test for <filepath>"}', RULE]

describe('readInputDraft — prompt line states', () => {
  it('typed text: a draft, no suggestion', () => {
    expect(readInputDraft(screen(RULE, '❯ fix the flaky test', RULE, ...FOOTER)))
      .toEqual({ state: 'draft', text: 'fix the flaky test' })
  })

  it('a suggestion only: empty, with the suggestion reported apart', () => {
    expect(readInputDraft(screen(RULE, '❯ {ok run the tests}', RULE, ...FOOTER)))
      .toEqual({ state: 'empty', suggestion: 'ok run the tests' })
  })

  it('typed text followed by a dim completion, on one line', () => {
    expect(readInputDraft(screen(RULE, '❯ /rev{iew}', RULE)))
      .toEqual({ state: 'draft', text: '/rev', suggestion: 'iew' })
  })

  it('an empty line: empty, and the stock hint is not a suggestion', () => {
    expect(readInputDraft(screen(RULE, '❯ ', RULE))).toEqual({ state: 'empty' })
    expect(readInputDraft(screen(...PLACEHOLDER_BEFORE))).toEqual({ state: 'empty' })
  })

  it('an open menu: unchanged, still unknown', () => {
    const s = screen('❯ /model', RULE, '  Select model', '  ❯ 2.  Opus 5.5 ✔', '  Enter to set as default · Esc to cancel')
    expect(readInputDraft(s).state).toBe('unknown')
  })

  it('typing over the placeholder replaces it, leaving nothing dim behind', () => {
    expect(readInputDraft(screen(...TYPED_OVER))).toEqual({ state: 'draft', text: 'hello' })
  })

  it('reads a Codex suggestion the same way', () => {
    expect(readInputDraft(screen('• ready', '› {summarize the diff}', '  GPT default · /tmp', '  ? for shortcuts')))
      .toEqual({ state: 'empty', suggestion: 'summarize the diff' })
  })
})

describe('markSuggestion', () => {
  const sb = ['⏺ Done. The report is ready.', '', '────', '❯ ok run the tests', '────', '  ⏵⏵ auto mode on'].join('\n')

  it('wraps a suggestion-only prompt line, so it does not read as a draft', () => {
    const out = markSuggestion(sb, { state: 'empty', suggestion: 'ok run the tests' })
    expect(out).toContain('❯ ⟨suggestion: ok run the tests⟩')
    expect(out).not.toContain('❯ ok start')
  })

  it('matches the stream with its spaces lost, and a line cut short', () => {
    const squashed = '────\n❯ okrunthe\n────'
    expect(markSuggestion(squashed, { state: 'empty', suggestion: 'ok run the tests' }))
      .toBe('────\n❯ ⟨suggestion: ok run the tests⟩\n────')
  })

  it('keeps typed text bare and marks only the completion', () => {
    expect(markSuggestion('────\n❯ /review\n────', { state: 'draft', text: '/rev', suggestion: 'iew' }))
      .toBe('────\n❯ /rev⟨suggestion: iew⟩\n────')
  })

  it('appends a note when no line spells the suggestion out', () => {
    const out = markSuggestion('⏺ hi\n', { state: 'empty', suggestion: 'run it' })
    expect(out).toBe('⏺ hi\n⟨input box: empty — the dim "run it" in it is Claude\'s prompt suggestion, not a draft⟩\n')
  })

  it('leaves scrollback alone for a draft, an empty box, or an unreadable one', () => {
    expect(markSuggestion(sb, { state: 'draft', text: 'ok run the tests' })).toBe(sb)
    expect(markSuggestion(sb, { state: 'empty' })).toBe(sb)
    expect(markSuggestion(sb, { state: 'unknown', why: 'old plugin' })).toBe(sb)
  })
})
