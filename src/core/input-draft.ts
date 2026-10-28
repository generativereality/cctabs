/**
 * What is in a Claude Code tab's input box right now. Pure.
 *
 * `send` types at the END of whatever is in the box and then presses Enter, so
 * a half-written message of the user's — or an unfinished prompt — was sent
 * with the cctabs text glued on. And a retry clears the line with Ctrl-U,
 * which wipes the user's draft outright. So before typing, `send` asks this.
 *
 * It reads the tab's SCREEN (the plugin's `screen` capability), never the
 * output stream: Claude redraws its input line by diffs, so in the stream a
 * typed draft arrives with its spaces gone and a backspace leaves no trace at
 * all — a deleted draft and a live one look the same. On the grid the box is
 * plain (measured on Claude Code 2.1.300 through a headless xterm 5.4.0, the
 * version Tabby ships):
 *
 *   ──────────────────────────────   rule (the top one may carry the session name)
 *   ❯ half written thought           the draft, bright
 *     second line                    a multi-line draft continues…
 *   ──────────────────────────────   …until the closing rule
 *
 * An empty box shows `❯` alone or followed by a DIM placeholder
 * (`Try "refactor <filepath>"`), which is why dim text is ignored.
 *
 * That placeholder is also where Claude Code puts its PROMPT SUGGESTION: the
 * guess at your next message that Tab accepts (`❯ ok run the tests`). It is the
 * same placeholder, so it is just as dim, and it is drawn only while the box is
 * empty: the input passes `placeholder: suggestion ?? hint`, and the
 * placeholder shows only when `value.length === 0` (read from Claude Code
 * 2.1.312's bundle; a real 2.1.312 screen confirms that typing `hello` over the
 * placeholder leaves `❯ hello` and nothing dim). So a suggestion is never a
 * draft, and typing over one replaces it. It is still reported, as
 * `suggestion`, because the escape-stripped scrollback prints it as plain text
 * and it reads exactly like something a person typed and never sent.
 */

export interface ScreenRow {
  text: string
  /** [start, end) ranges of dim text in `text`. */
  dim: Array<[number, number]>
}

export type DraftState =
  /**
   * The input box is on screen and holds nothing but its placeholder.
   * `suggestion` is a prompt suggestion shown there: dim ghost text, not typed.
   */
  | { state: 'empty'; suggestion?: string }
  /**
   * Something is typed or pasted in the box. `suggestion` is a dim completion
   * drawn after it, which is not part of what Enter would send.
   */
  | { state: 'draft'; text: string; suggestion?: string }
  /**
   * The box couldn't be read: no Claude input box on screen (a shell, a
   * picker, a dialog), or no screen at all. Not evidence of a draft.
   */
  | { state: 'unknown'; why: string }

const RULE = /^\s*─{3,}.*─\s*$/
/** `❯ 1. Yes, I trust this folder` — a picker's selection marker, not the box. */
const PICKER = /^\s*❯\s*\d+\.\s/

/** `text`'s dim ranges, joined. */
function dimText(row: ScreenRow): string {
  return [...row.dim].sort((a, b) => a[0] - b[0]).map(([s, e]) => row.text.slice(s, e)).join('')
}

/**
 * The dim text in the box, as a suggestion — or undefined when there is none,
 * or it is Claude's stock hint (`Try "refactor <filepath>"`), which nobody
 * would mistake for a message. Codex's equivalent is `Ask Codex to do anything`.
 */
function suggestionIn(dim: string): string | undefined {
  const t = dim.replace(/[\s\u00a0]+/g, ' ').trim()
  if (!t || /^Try ".*"$/.test(t) || t === 'Ask Codex to do anything') return undefined
  return t
}

/** `text` with its dim ranges removed. */
function brightText(row: ScreenRow): string {
  let out = ''
  let at = 0
  for (const [s, e] of [...row.dim].sort((a, b) => a[0] - b[0])) {
    if (s > at) out += row.text.slice(at, s)
    at = Math.max(at, e)
  }
  return out + row.text.slice(at)
}

export function readInputDraft(rows: ScreenRow[]): DraftState {
  // The LAST prompt row that sits directly under a rule: earlier ones are
  // scrolled-up history, and a `❯` without a rule above it is something else.
  let at = -1
  for (let i = rows.length - 1; i > 0; i--) {
    if (/^\s*❯/.test(rows[i].text) && RULE.test(rows[i - 1].text)) { at = i; break }
  }
  if (at < 0) return readCodexDraft(rows)
  if (PICKER.test(rows[at].text)) return { state: 'unknown', why: 'a picker is open, not the input box' }

  const lines: string[] = []
  let closed = false
  for (let i = at; i < rows.length; i++) {
    if (i > at && RULE.test(rows[i].text)) { closed = true; break }
    lines.push(brightText(rows[i]))
  }
  if (!closed) return { state: 'unknown', why: 'the input box runs off the screen' }

  lines[0] = lines[0].replace(/^\s*❯/, '')
  const text = lines.map((l) => l.replace(/[\s ]+$/, '').replace(/^[\s ]+/, '')).filter(Boolean).join('\n')
  const suggestion = suggestionIn(rows.slice(at, at + lines.length).map(dimText).join(' '))
  const extra = suggestion ? { suggestion } : {}
  return text ? { state: 'draft', text, ...extra } : { state: 'empty', ...extra }
}

/**
 * Backoff schedule for waiting out a draft: 1s, 2s, 4s … capped at `maxStepMs`,
 * cut so the total never exceeds `totalMs`. Pure, so the schedule is testable.
 */
export function draftBackoff(totalMs: number, firstMs = 1000, maxStepMs = 16000): number[] {
  const steps: number[] = []
  let spent = 0
  for (let step = firstMs; spent < totalMs; step = Math.min(step * 2, maxStepMs)) {
    const s = Math.min(step, totalMs - spent)
    steps.push(s)
    spent += s
  }
  return steps
}

/**
 * Codex's input box (`cctabs new … --engine codex`). Codex always draws its
 * input as the LAST `›` row on screen; submitted prompts sit above it. Its
 * placeholder (`Ask Codex to do anything`) is dim, like Claude's.
 *
 * Not anchored on the `? for shortcuts` footer: Codex hides that line while
 * something is typed in the box — exactly when a draft is there (measured
 * 2026-10-15; the first version keyed on it and let `send` type into a draft).
 * Only taken on a screen that is recognisably Codex, so a shell prompt drawn
 * with `›` is not read as one.
 */
function readCodexDraft(rows: ScreenRow[]): DraftState {
  const all = rows.map((r) => r.text).join('\n')
  if (!/OpenAI Codex|Ask Codex to do anything|Worked for \d|• Working \(|for shortcuts/.test(all)) {
    return { state: 'unknown', why: 'no Claude or Codex input box on screen' }
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!/^\s*›/.test(rows[i].text)) continue
    const text = brightText(rows[i]).replace(/^\s*›/, '').replace(/^[\s\u00a0]+|[\s\u00a0]+$/g, '')
    const suggestion = suggestionIn(dimText(rows[i]))
    const extra = suggestion ? { suggestion } : {}
    return text ? { state: 'draft', text, ...extra } : { state: 'empty', ...extra }
  }
  return { state: 'unknown', why: 'no Codex input row on screen' }
}

/**
 * Mark the prompt suggestion in scrollback text. Pure.
 *
 * Scrollback is the PTY stream with its escapes stripped, so a suggestion
 * arrives there as plain text after `❯`, indistinguishable from a typed draft
 * — a driver reading it held back sends for hours on what was Claude's own
 * ghost text. Given what the screen says is in the box, the last prompt line
 * that spells it out becomes `❯ ⟨suggestion: …⟩` (typed text, if any, stays
 * bare in front). Compared with whitespace removed, because the stream loses
 * spaces that Claude draws as cursor moves; a line cut short still matches.
 * When no line matches, a note is appended instead, so the reader still hears
 * that the box holds no draft.
 */
export function markSuggestion(scrollback: string, state: DraftState): string {
  if (state.state === 'unknown' || !state.suggestion) return scrollback
  const typed = state.state === 'draft' ? state.text : ''
  const marked = `${typed}⟨suggestion: ${state.suggestion}⟩`
  const squash = (s: string) => s.replace(/[\s ]+/g, '')
  const whole = squash(typed + state.suggestion)
  const lines = scrollback.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\s*❯\s?)(.*)$/.exec(lines[i])
    if (!m) continue
    const rest = squash(m[2]).replace(/…$/, '')
    if (rest && whole.startsWith(rest) && rest.length > squash(typed).length) {
      lines[i] = m[1] + marked
      return lines.join('\n')
    }
  }
  const note = typed
    ? `⟨input box: "${typed}" is typed; the dim "${state.suggestion}" after it is Claude's suggestion, not typed⟩`
    : `⟨input box: empty — the dim "${state.suggestion}" in it is Claude's prompt suggestion, not a draft⟩`
  return scrollback.replace(/\n*$/, (end) => `\n${note}${end || ''}`)
}
