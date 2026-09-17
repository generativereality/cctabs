/**
 * Why a tab's `session_id` is null — because "null" alone has been read as
 * three different things and acted on wrongly.
 *
 * A caller seeing `session_id: null` cannot tell whether cctabs looked and
 * found nothing (the tab really has no session), looked and *couldn't* (the
 * project dir was unreadable), or never looked at all (the tab reported no
 * cwd). Those want opposite responses: the first is a tab to spawn fresh, the
 * second and third are bugs to fix before touching the fleet. Observed on a
 * real fleet as a tab whose session was perfectly readable but whose transcript
 * was filed under a title that no longer matched the tab.
 */
export type SessionLookup =
  /** Resolved — `session_id` is set. */
  | 'found'
  /** The tab reported no working directory, so there was nothing to look up. */
  | 'no-cwd'
  /** Searched every config dir; no session is titled after this tab. */
  | 'not-found'
  /** The search itself threw — a permissions or filesystem problem, not an answer. */
  | 'lookup-failed'

export interface SessionLookupResult {
  status: SessionLookup
  /**
   * How many transcripts exist for this tab's directory regardless of title,
   * for the `not-found` case. `> 0` means the directory has history and it is
   * the *name* that stopped matching — a renamed tab, not a dead one. Only set
   * when it's the distinction that matters.
   */
  sessionsInDir?: number
  /** The error text, for `lookup-failed`. */
  detail?: string
}

/**
 * Classify one tab's session lookup. Pure, so the four outcomes are testable
 * without a terminal or a home directory.
 */
export function classifySessionLookup(opts: {
  cwd: string
  found: boolean
  error?: Error
  /** Injected so the count is only paid for when it's the deciding factor. */
  countInDir: () => number
}): SessionLookupResult {
  if (opts.found) return { status: 'found' }
  if (opts.error) return { status: 'lookup-failed', detail: opts.error.message }
  if (!opts.cwd) return { status: 'no-cwd' }
  return { status: 'not-found', sessionsInDir: opts.countInDir() }
}

/** One-line explanation of a lookup that produced no id, for the human view. */
export function explainSessionLookup(r: SessionLookupResult): string | null {
  switch (r.status) {
    case 'found':
      return null
    case 'no-cwd':
      return 'no session id: the tab reports no working directory, so none could be looked up'
    case 'lookup-failed':
      return `no session id: the lookup failed (${r.detail}) — this is unknown, not absent`
    case 'not-found':
      return r.sessionsInDir
        ? `no session id: nothing here is titled after this tab, but ${r.sessionsInDir} transcript(s) exist for its directory — it was probably renamed after Claude started`
        : 'no session id: no Claude session has ever run in this directory'
  }
}
