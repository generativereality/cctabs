import type { PermissionMode, SessionStatus } from '../types/index.js'

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

/**
 * The mode pill Claude Code prints in its footer, and the `--permission-mode`
 * value that reproduces it.
 *
 * Read off a live fleet by cycling shift+tab through a probe session and
 * comparing the footer against `claude --permission-mode <v>` on resume. The
 * glyph is optional in the pattern because the plugin's buffer occasionally
 * splits it away from the text it decorates.
 */
const MODE_PILLS: ReadonlyArray<readonly [RegExp, PermissionMode]> = [
  [/(⏵⏵)?accepteditson/g, 'acceptEdits'],
  [/(⏵⏵)?bypasspermissionson/g, 'bypassPermissions'],
  [/(⏸)?planmodeon/g, 'plan'],
  [/(⏸)?manualmodeon/g, 'manual'],
  [/(⏵⏵)?automodeon/g, 'auto'],
]

/**
 * The permission mode a session is in *right now*, read from its footer.
 *
 * Why the footer and not the transcript: the transcript's `permission-mode`
 * entries are written at turn boundaries, not when the mode changes. Cycling a
 * probe session shift+tab through manual → plan → bypass → auto left its last
 * recorded value at `auto` the entire time, and it only caught up once a prompt
 * was submitted. So the transcript is the mode as of the last turn, while the
 * footer is the mode now — and a tab whose mode was changed and then left alone
 * is exactly the tab a restore would otherwise bring back wrong.
 *
 * The buffer accumulates redraws, so every mode the session has ever been in is
 * somewhere in it. The last pill wins.
 */
export function parsePermissionMode(buffer: string): PermissionMode | undefined {
  if (!buffer.trim()) return undefined
  const compact = stripWhitespace(buffer)

  let best: PermissionMode | undefined
  let bestAt = -1
  for (const [pattern, mode] of MODE_PILLS) {
    pattern.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = pattern.exec(compact)) !== null) {
      if (m.index > bestAt) {
        bestAt = m.index
        best = mode
      }
    }
  }
  return best
}

/** Every mode `claude --permission-mode` will accept from us. */
const LAUNCHABLE_MODES: ReadonlySet<string> = new Set<PermissionMode>([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'plan',
])

/**
 * Narrow an arbitrary recorded string to a mode we can safely launch with.
 *
 * Transcripts and hand-edited manifests contain values the flag rejects — most
 * commonly `default`, which appears in real transcripts and would make the
 * relaunch fail outright rather than degrade. Anything unrecognised is dropped
 * so the caller falls back to the configured flags.
 */
export function toLaunchableMode(value: unknown): PermissionMode | undefined {
  return typeof value === 'string' && LAUNCHABLE_MODES.has(value)
    ? (value as PermissionMode)
    : undefined
}
