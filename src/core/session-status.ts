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
 * Claude's startup dialogs, which block a tab until answered.
 *
 * Both appear *after* the process starts and *before* the session is usable, so
 * a tab sitting on one looks successfully launched from the outside — `restore`
 * reports it spawned, the process is alive, and the conversation never loads.
 * On a 65-tab restore this stranded 10 tabs, and the only symptom that surfaced
 * was an unreadable permission mode (a blocked tab never paints a footer).
 *
 * Detection is deliberately on the *option text* rather than the prose. The
 * prose is long, wraps at the terminal width, and Tabby's buffer drops spaces
 * between glyphs — the options are short, stable, and unique to each dialog.
 */

/**
 * "Quick safety check: Is this a project you created or one you trust?"
 *
 * ⛔ The option ORDER is not stable across Claude Code releases, and that is
 * what makes this dialog dangerous to automate. Older builds:
 *
 *   ❯ 1. Yes, I trust this folder
 *     2. No, exit
 *
 * Current builds (seen 2026-09-23 on a restored tab) — and note: NO numbers:
 *
 *   ❯ No, exit
 *     Yes, I trust this folder
 *
 * A bare Enter takes "No, exit" on the second layout and the session quits.
 * So the dialog is answered by locating the Yes option and the cursor — see
 * {@link trustDialogState} — never by pressing Enter on whatever is highlighted.
 */
export function trustDialogVisible(buffer: string): boolean {
  const c = stripWhitespace(buffer)
  return /Yes,?Itrustthisfolder/i.test(c)
}

/** Where the trust dialog's options are, and which one the cursor is on. */
export interface TrustDialogState {
  /** Option number of "Yes, I trust this folder", if it is on screen. */
  yes?: number
  /** Option number of "No, exit", if it is on screen. */
  no?: number
  /** Option number the cursor (❯) is on in the LATEST render, if readable. */
  cursor?: number
}

/**
 * Read the trust dialog's layout off a captured buffer. Pure.
 *
 * The buffer is the raw output stream, so every redraw is appended after the
 * last: the most recent occurrence of each option is the current one. The
 * cursor is read the same way — the last option line carrying the ❯ glyph —
 * which holds whether the TUI repaints the whole menu or only the lines that
 * changed (both put the newly highlighted line after the old one).
 *
 * `cursor` is left undefined rather than guessed when no option line carries a
 * glyph. The caller must then NOT press Enter: an unknown cursor on this dialog
 * is a coin toss between trusting the folder and quitting the session.
 */
export function trustDialogState(buffer: string): TrustDialogState {
  const c = stripWhitespace(buffer)
  const opt = /([❯›>])?(?:(\d)\.)?(Yes,?Itrustthisfolder|No,?exit)/gi
  const matches: Array<{ glyph: boolean; num?: number; yes: boolean }> = []
  let m: RegExpExecArray | null
  while ((m = opt.exec(c)) !== null) {
    matches.push({ glyph: !!m[1], num: m[2] ? Number(m[2]) : undefined, yes: /^Yes/i.test(m[3]) })
  }
  if (!matches.length) return {}

  // Option positions. Numbered layouts say so; the current one draws no
  // numbers at all (measured: `❯No,exit` / `Yes,Itrustthisfolder`), so the
  // position is the order the two options first appear in.
  const firstYes = matches.findIndex((x) => x.yes)
  const firstNo = matches.findIndex((x) => !x.yes)
  const numbered = matches.some((x) => x.num !== undefined)
  const pos = (isYes: boolean): number | undefined => {
    if (numbered) return [...matches].reverse().find((x) => x.yes === isYes && x.num !== undefined)?.num
    const here = isYes ? firstYes : firstNo
    const other = isYes ? firstNo : firstYes
    if (here < 0) return undefined
    return other < 0 || here < other ? 1 : 2
  }

  const out: TrustDialogState = {}
  const yes = pos(true)
  const no = pos(false)
  if (yes !== undefined) out.yes = yes
  if (no !== undefined) out.no = no
  const lastGlyph = [...matches].reverse().find((x) => x.glyph)
  if (lastGlyph) out.cursor = lastGlyph.yes ? yes : no
  return out
}

/**
 * Claude Code's first-launch MCP approval prompt ("New MCP server found in
 * .mcp.json … Use this and all future MCP servers in this project / Use this
 * MCP server / Continue without using this MCP server").
 *
 * Never answered automatically: which servers a project may run is a security
 * decision, not a startup formality. Detected so a wake can stop and SAY it is
 * blocked, rather than timing out on a prompt nobody was told about.
 */
export function mcpApprovalDialogVisible(buffer: string): boolean {
  const c = stripWhitespace(buffer)
  return /NewMCPservers?found/i.test(c) || /UsethisandallfutureMCPservers/i.test(c) || /ContinuewithoutusingthisMCPserver/i.test(c)
}

/**
 * Footer strings that only Claude's live chat input draws. Any of them in the
 * last few lines means the input box is up and the session is past its
 * startup dialogs — the dialogs draw ❯ too, so the glyph alone proves nothing.
 *
 * `Checking for updates` and `/rc` are the status line, which redraws every
 * second or so under the input box and, on an idle session, is the ONLY thing
 * in the last dozen lines (measured — see IDLE_TAIL in the tests). Without them
 * a perfectly ready tab reads as not ready.
 */
const INPUT_FOOTER = [
  'checkingforupdates',
  '/rc',
  'automode',
  'foragents',
  'shift+tabtocycle',
  '?forshortcuts',
  'bypasspermissionson',
  'accepteditson',
  'planmodeon',
  'manualmodeon',
]

/**
 * Is Claude's chat input up and waiting, judged from the tail of a buffer?
 * Pure.
 *
 * Read off the LAST lines only. A resumed session repaints its history, and a
 * conversation about Claude Code quite plausibly contains "auto mode" or "for
 * agents" in its text; only the footer is guaranteed to sit at the bottom.
 * Callers should still require the answer to hold across two reads, since a
 * history repaint can pass through the tail on its way up.
 */
export function claudeInputReady(buffer: string, tailLines = 12): boolean {
  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return false
  const tail = stripWhitespace(lines.slice(-tailLines).join('\n'))
  if (trustDialogVisible(tail) || autoModeDialogVisible(tail) || mcpApprovalDialogVisible(tail)) return false
  if (/Resumefromsummary/i.test(tail) && /Resumefullsession/i.test(tail)) return false
  if (/Try["'“]/.test(tail)) return true
  return INPUT_FOOTER.some((m) => tail.toLowerCase().includes(m.toLowerCase()))
}

/**
 * The placeholder's on-screen marker — printed by a suspended tab, see
 * core/suspend.ts. A constant here rather than there so the classifier and
 * the script that prints it cannot drift apart.
 */
export const SUSPEND_MARKER = '⏸ cctabs suspended'

/**
 * Is a cctabs placeholder the most recent thing on screen? Pure.
 *
 * "Most recent" matters because the buffer is append-only: a tab that was
 * suspended and later woken still has the marker in it, above the Claude that
 * is now running. So the marker counts only within the last few non-empty
 * lines — the placeholder prints the marker and one hint line, then waits.
 */
export function suspendMarkerShowing(buffer: string): boolean {
  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)
  const marker = stripWhitespace(SUSPEND_MARKER)
  return lines.slice(-3).some((l) => stripWhitespace(l).includes(marker))
}

/**
 * Everything that can say whether a tab is suspended. See {@link isSuspended}.
 */
export interface SuspendSignals {
  /** The suspended-tab registry has an entry for this tab (by id, or by name after drift). */
  registered: boolean
  /**
   * The placeholder process for this tab's session, from the process table:
   * `waiting` at its prompt, `woken` (a Claude now runs beneath it), or
   * `absent`. Undefined when there is no process table to read.
   */
  placeholder?: 'waiting' | 'woken' | 'absent'
  /** A Claude process is matched to this tab. */
  claudeRunning: boolean
  /** Whether the tab's own shell is alive; undefined when the backend can't say. */
  shellAlive?: boolean
  /** The placeholder marker is the latest thing in the tab's captured output. */
  bufferMarker: boolean
}

/**
 * Is this tab suspended? Pure.
 *
 * Every `true` here rests on a positive signal: the placeholder process seen
 * waiting, or the registry entry cctabs wrote when it suspended the tab, or
 * the placeholder's marker on screen. An empty buffer, a missing process or an
 * unmatched tab never produces `true` — the same invariant as the rest of this
 * file, where emptiness means "can't tell".
 *
 * Contradictions resolve towards NOT suspended, because being wrong that way is
 * cheap (a wake finds nothing to wake) while being wrong the other way sends a
 * wake keypress into a tab that is running something else.
 */
export function isSuspended(s: SuspendSignals): boolean {
  if (s.claudeRunning) return false
  if (s.placeholder === 'woken') return false
  if (s.placeholder === 'waiting') return true
  if (s.placeholder === 'absent') {
    // The process table is readable and no placeholder is waiting for this
    // session. A live shell that isn't the placeholder means the registry is
    // stale (woken by hand, then Claude quit). No live shell at all is a
    // dormant tab — Tabby restarted and has not spawned it yet — and the
    // registry is the only thing that still knows what belongs there.
    if (s.shellAlive === true) return false
    return s.registered
  }
  // No process table: the registry, then the marker.
  return s.registered || s.bufferMarker
}

/**
 * "Set up auto mode for your environment?"
 *   ❯ 1. Set it up
 *     2. Not now
 *     3. Don't show again
 *
 * Unlike the trust dialog, the default here is the one we do NOT want: a bare
 * Enter starts an interactive setup that explores the repo and proposes
 * settings, which is not something a restore should trigger on the user's
 * behalf across a whole fleet. Answering it requires ↓ once, then Enter.
 *
 * Option 3 is off limits for the same reason as the resume picker's — it
 * permanently suppresses a prompt the user may want later, and that is the
 * user's call to make, not ours.
 */
export function autoModeDialogVisible(buffer: string): boolean {
  const c = stripWhitespace(buffer)
  return /Setupautomodeforyourenvironment/i.test(c) || (/1\.Setitup/i.test(c) && /2\.Notnow/i.test(c))
}

/**
 * Is a tab's input ready to receive text?
 *
 * Read across the whole window rather than off the last line alone, and that is
 * the fix rather than a preference: Claude Code renders notices BELOW its input
 * line — `Restart to update` is the one that caught this — so the last non-empty
 * line is the banner and the ready prompt is a line or two above it.
 * `--wait-for-prompt` consequently timed out at 20s against tabs whose prompts
 * were sitting there ready, which is worse than no check, because the caller
 * concludes the tab is broken and stops.
 *
 * Accepts any of the ready shapes: a bare shell prompt at end-of-line, Claude's
 * `❯` input line (usually followed by a `Try "…"` placeholder, so the glyph is
 * NOT at end-of-line), or Claude's input footer.
 */
export function promptIsReady(buffer: string): boolean {
  if (!buffer.trim()) return false
  const lines = buffer.split('\n').map((l) => l.trim()).filter(Boolean)

  for (const line of lines) {
    if (/[$%>]\s*$/.test(line)) return true
    if (/^❯/.test(line)) return true
  }

  return /automode|foragents/i.test(stripWhitespace(buffer))
}

/**
 * Classify a tab from the text of its captured output.
 *
 * Order is load-bearing:
 *
 *   1. Nothing captured → 'unreadable'. Never 'terminal', never "dead".
 *   1a. The cctabs placeholder marker as the latest output → 'suspended'.
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

  // A positive marker, checked first because the placeholder's hint line is
  // not a shell prompt and its banner is not Claude chrome — without this a
  // suspended tab reads as a bare 'terminal'.
  if (suspendMarkerShowing(buffer)) return 'suspended'

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
