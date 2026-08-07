import type { SessionStatus } from '../types/index.js'

/**
 * What a terminal tab's captured output says about the Claude session in it.
 *
 * Pure and separate from the adapters so the rules are testable without a
 * terminal, and so `sessions`, `restore` and `resume` all classify identically.
 *
 * Two things this must keep straight, because conflating them has already cost
 * a user a live tab:
 *
 *   - **Readability is not liveness.** An empty capture means the backend has
 *     no output recorded for this tab. That is a statement about the capture,
 *     not about the session. The Tabby plugin accumulates output by subscribing
 *     to each tab's `output$`, and a tab whose session attached after the
 *     subscriber gave up is never captured at all — it reads empty forever
 *     while Claude runs happily inside it. Hence 'unreadable', and hence
 *     nothing in this file may conclude "there is no session here".
 *   - **Present is not busy.** Claude Code's chrome (the banner, the mode
 *     pill, the `/rc` status line) is on screen whether or not a turn is in
 *     flight, so matching it proves only that Claude is there. Only the spinner
 *     means work is happening.
 */

/**
 * Claude Code's chrome — on screen for the whole life of a session. Presence
 * proves Claude is in the tab; it says nothing about whether it is working.
 *
 * `Checking for updates` and `/rc` earn their place here: a long-context
 * session sitting at an empty prompt redraws little else, and the startup
 * banner has long since scrolled out of the ring buffer. Without them such a
 * tab reads as a bare shell.
 */
const PRESENCE_MARKERS = [
  'Claude Code',
  'claude.ai/code',
  'new task?',
  'Checking for updates',
  '⏵⏵ bypass',
  '⏵⏵ auto',
  '⏵⏵ accept edits',
  '⏸ plan',
  '⏸ manual',
  'shift+tab to cycle',
  'for agents',
]

/**
 * Spinner labels Claude Code cycles while a turn is in flight. Not exhaustive —
 * the vocabulary is long and changes between releases — which is why
 * {@link SPINNER_GLYPHS} does the real work and these are a supplement.
 */
const SPINNER_LABELS = [
  'Thinking',
  'Hatching',
  'Composing',
  'Cogitating',
  'Befuddling',
  'Marinating',
  'Dilly-dallying',
  'Pondering',
  'Percolating',
  'Simmering',
  'esc to interrupt',
]

/** Glyphs the spinner cycles through regardless of label. */
const SPINNER_GLYPHS = /[✻✽✶✳✢]/

/**
 * The tell of a completion notice — `✻ Baked for 47s`, `✻ Sautéed for 4m 1s`,
 * `✻ Worked for 11m 4s`. These carry a spinner glyph but mean the opposite of
 * busy: the turn just ENDED. Treating them as in-flight is precisely how
 * "active" came to mean nothing.
 *
 * Matched by shape, not by verb. The verb list is open-ended and changes
 * between releases — an enumerated one missed `Sautéed for` on the first real
 * fleet it met — whereas "for" followed by a duration is stable, and the
 * in-flight spinner's own elapsed time (`(14m 5s · ↓34.9k tokens)`) never
 * spells "for".
 */
const COMPLETION = /for\d+[hms]/

/**
 * How many trailing lines count as "now".
 *
 * The buffer is an accumulating ring of everything the tab ever emitted, not a
 * viewport, so a spinner glyph somewhere in the last 200 lines only proves the
 * session was busy at some point. Claude redraws its status line every second
 * or so, which pushes a finished turn's spinner out of a short window fast —
 * measured on a real fleet, an idle tab's last 15 lines are `/rc` and
 * `Checking for updates` and nothing else.
 */
const RECENT_LINES = 15

const stripWhitespace = (s: string) => s.replace(/\s+/g, '')

/** True when `haystack` (already whitespace-stripped) contains `marker`. */
const hasMarker = (haystack: string, marker: string) =>
  haystack.includes(stripWhitespace(marker))

/**
 * Classify a tab from the text of its captured output.
 *
 * Order is load-bearing:
 *
 *   1. Nothing captured → 'unreadable'. Never 'terminal', never "dead".
 *   2. A shell prompt on the last line → 'terminal'. Checked before any Claude
 *      marker because the buffer keeps the UI of a Claude that has since
 *      exited, so markers alone would keep reporting a bare shell as a session.
 *   3. Spinner in the recent window → 'active' (a turn is in flight).
 *   4. Claude chrome anywhere → 'idle' (present, waiting for input).
 *
 * Ambiguity resolves towards 'idle' rather than 'active': under-reporting busy
 * is a cosmetic loss, whereas over-reporting it is what made the field useless.
 */
export function classifyTerminalBuffer(buffer: string): SessionStatus {
  if (!buffer.trim()) return 'unreadable'

  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return 'unreadable'

  const lastLine = lines.at(-1) ?? ''
  if (/[$%>]\s*$/.test(lastLine) && !lastLine.includes('claude')) {
    return 'terminal'
  }

  // Tabby's buffer endpoint can drop the spaces between adjacent characters
  // depending on how Claude rendered them, so compare whitespace-stripped
  // text against whitespace-stripped markers throughout.
  const recent = stripWhitespace(lines.slice(-RECENT_LINES).join('\n'))
  const all = stripWhitespace(buffer)

  const spinning =
    SPINNER_GLYPHS.test(recent) || SPINNER_LABELS.some((m) => hasMarker(recent, m))
  if (spinning) {
    // Spinner line present. A duration in the same window is what separates
    // "✻ Baked for 47s" (finished, and itself proof Claude is here) from
    // "✽ Dilly-dallying… (14m 5s)" (still going). When both a finished notice
    // and a live spinner are in view we say idle: under-reporting busy is
    // cosmetic, over-reporting it is what we are fixing.
    return COMPLETION.test(recent) ? 'idle' : 'active'
  }

  if (PRESENCE_MARKERS.some((m) => hasMarker(all, m))) return 'idle'
  if (lastLine.toLowerCase().includes('claude')) return 'idle'
  return 'terminal'
}
