/**
 * How `cctabs rename` makes a new name stick. Pure.
 *
 * A running Claude holds its title in memory and appends it to the transcript
 * — a `custom-title` + `agent-name` pair — after every turn. So a title cctabs
 * appends behind its back lasts exactly until the next turn, and the name that
 * survives a restart is the OLD one. Measured on Claude Code 2.1.296: a
 * cctabs-written `custom-title` was followed by the previous title on the very
 * next turn; and in the fleet, `pay-bills-2609` was re-asserted 13 times after
 * `cctabs rename … pay-bills-3009` (2026-10-05), so name-based restore missed it.
 *
 * Claude's own `/rename <name>` changes the in-memory title and writes the pair
 * at once. Sent mid-turn it is queued and applied when the turn ends — also
 * measured. So the running case goes through Claude, and the disk append is
 * kept for a tab with no Claude running, where nothing will overwrite it.
 */

export type RenameRoute =
  /** Claude is running in the tab: have it rename itself. */
  | { kind: 'slash'; text: string }
  /** No Claude running, session known: append the title to its transcript. */
  | { kind: 'disk' }
  /** Nothing to persist — a plain shell, or a session cctabs cannot find. */
  | { kind: 'tab-only' }

export function renameRoute(o: { claudeRunning: boolean; sessionFile: string | null; newName: string }): RenameRoute {
  if (o.claudeRunning) return { kind: 'slash', text: `/rename ${o.newName}` }
  if (o.sessionFile) return { kind: 'disk' }
  return { kind: 'tab-only' }
}

/**
 * Why `name` can't be a tab/session name, or null if it can. A control
 * character would end the `/rename` line early (a newline submits it) or be
 * typed into the TUI as a keystroke.
 */
export function invalidNameReason(name: string): string | null {
  if (!name.trim()) return 'the name is empty'
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return 'the name contains a control character (newline, tab, escape…)'
  return null
}

/** The LAST `customTitle` in a transcript's text — the one name lookup uses. */
export function lastCustomTitle(jsonl: string): string | undefined {
  let title: string | undefined
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"custom-title"')) continue
    try {
      const e = JSON.parse(line) as { type?: string; customTitle?: unknown }
      if (e.type === 'custom-title' && typeof e.customTitle === 'string') title = e.customTitle
    } catch { /* a torn last line */ }
  }
  return title
}
