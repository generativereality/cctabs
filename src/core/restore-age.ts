import type { RestoreEntry } from './restore-plan.js'

/**
 * `restore --suspend-older-than <age>`: one run that brings recent sessions
 * back running and older ones back suspended.
 *
 * It exists because the alternative was two runs — a full restore of the
 * recent batch, then a `--suspended` one of the rest — and two runs means two
 * decisions about the bar, which is how a suspended batch once ended up in
 * front of the active one. With the split made per entry, the manifest's order
 * is the bar's order. Pure: the activity lookup is injected.
 */

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
}

/**
 * The cutoff, in epoch ms, that an age argument names: a duration before `now`
 * (`90m`, `12h`, `3d`, `2w`), or a date / date-time (`2026-10-10`,
 * `2026-10-10T18:00`), read as local time like everything else a user types.
 */
export function parseAgeCutoff(input: string, now: number = Date.now()): number {
  const trimmed = input.trim()
  const rel = /^(\d+)\s*([mhdw])$/i.exec(trimmed)
  if (rel) return now - Number(rel[1]) * UNIT_MS[rel[2].toLowerCase()]
  if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/.test(trimmed)) {
    // Date-only strings parse as UTC midnight; a person means their own midnight.
    const local = trimmed.length === 10 ? `${trimmed}T00:00` : trimmed.replace(' ', 'T')
    const t = new Date(local).getTime()
    if (Number.isFinite(t)) return t
  }
  throw new Error(`--suspend-older-than: "${input}" is neither an age (90m, 12h, 3d, 2w) nor a date (2026-10-10)`)
}

export interface AgeSplit {
  entries: RestoreEntry[]
  /** Entries newly marked suspended. */
  suspended: number
  /** Entries with a session whose last activity could not be read — left as they were. */
  unknown: string[]
}

/**
 * Mark every entry whose session was last active before `cutoff` as suspended.
 *
 * An entry already marked suspended stays so, and one without a session id is
 * left alone (a fresh Claude has nothing to suspend). An entry whose activity
 * can't be read is left running and named, rather than guessed at either way.
 */
export function suspendOlderThan(
  entries: RestoreEntry[],
  cutoff: number,
  lastActivity: (sessionId: string) => number | undefined,
): AgeSplit {
  let suspended = 0
  const unknown: string[] = []
  const out = entries.map((e) => {
    if (e.suspended || !e.sessionId) return e
    const at = lastActivity(e.sessionId)
    if (at === undefined) {
      unknown.push(e.name)
      return e
    }
    if (at >= cutoff) return e
    suspended++
    return { ...e, suspended: true }
  })
  return { entries: out, suspended, unknown }
}

/**
 * When a transcript last had a real message: the timestamp of its last `user`
 * or `assistant` entry, in epoch ms. Pure — given the tail of the file.
 *
 * Not the file's mtime. A closing Claude appends a metadata trailer
 * (`custom-title`, `agent-name`, `last-prompt`…) on its way out, so closing a
 * fleet stamps every transcript with the time of the close. Measured
 * 2026-10-15: after a fleet close, `--suspend-older-than 3d` by mtime found
 * 0 of 96 sessions idle — and would have started all 96 at once.
 */
export function lastMessageAt(jsonlTail: string): number | undefined {
  const lines = jsonlTail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line.includes('"timestamp"')) continue
    try {
      const e = JSON.parse(line) as { type?: string; timestamp?: string; payload?: { type?: string; role?: string } }
      if ((e.type === 'user' || e.type === 'assistant' || (e.type === 'response_item' && e.payload?.type === 'message' && ['user', 'assistant'].includes(e.payload.role ?? ''))) && e.timestamp) {
        const t = Date.parse(e.timestamp)
        if (Number.isFinite(t)) return t
      }
    } catch { /* a torn line — the first one of a tail chunk, usually */ }
  }
  return undefined
}
