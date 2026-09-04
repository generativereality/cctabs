import { sep } from 'path'
import { WORKTREE_SEGMENT } from './worktree.js'

/**
 * "Which cctabs tab am I running in?" — the question a Claude session needs
 * answered in order to attribute its own work (a PR body, a commit trailer, a
 * status post) to something a human can find again.
 *
 * Deliberately cheap. The obvious implementation goes through
 * `cctabs sessions --json`, which resolves every tab's session by scanning the
 * transcripts in each project directory — measured at 9s warm on a 65-tab fleet
 * with ~1.7GB of history, and minutes cold. That cost is fine once; it is not
 * fine on every PR. Nothing here reads a transcript.
 */

/** Printed (and matched on) when the session isn't in a cctabs tab at all. */
export const UNKNOWN_TAB = 'unknown'

/** A tab reduced to the fields identity needs. */
export interface WhoamiTab {
  tabId: string
  name: string
  cwd?: string | null
  color?: string | null
}

export interface WhoamiIdentity {
  /** Tab name, or null when this session isn't in a cctabs tab. */
  tab: string | null
  tabId: string | null
  /** The session's own id, from CLAUDE_CODE_SESSION_ID. */
  sessionId: string | null
  cwd: string | null
  /**
   * `.claude/worktrees/<name>` when the cwd is inside a worktree, else null.
   * Relative, because that is the form a reader is given to check.
   */
  worktree: string | null
  /** Claude account this session belongs to, when not the default. */
  backend?: string
  configDir?: string
  color?: string | null
  /**
   * How the tab was identified, so a miss can be diagnosed rather than guessed
   * at. `pid` is the process-tree match; `session-slug` is the fallback below.
   */
  via: 'pid' | 'session-slug' | null
}

/**
 * The worktree a directory sits in, as `.claude/worktrees/<name>`.
 *
 * Textual, so it still answers after the worktree has been deleted — which is
 * when a reader most wants to know what the session was working on.
 */
export function worktreeOf(cwd: string | null | undefined): string | null {
  if (!cwd) return null
  const marker = `${sep}${WORKTREE_SEGMENT}${sep}`
  const idx = cwd.indexOf(marker)
  if (idx === -1) return null
  const name = cwd.slice(idx + marker.length).split(sep)[0]
  return name ? `${WORKTREE_SEGMENT}${sep}${name}` : null
}

/**
 * Pick the tab this session is running in.
 *
 * Two independent routes, because neither is sufficient alone:
 *
 *   1. `pid` — the terminal matched our process tree to a tab. Definitive when
 *      it answers: it is the tab the process is actually inside.
 *   2. `session-slug` — the fallback for when it doesn't answer (an SSH hop or
 *      a deep process chain can break the pid walk, and the horizon convention
 *      that motivated this command warns about exactly that). We know our own
 *      session id, so we know which project directory its transcript lives in;
 *      a tab whose cwd maps to that same directory is us. Only accepted when
 *      exactly one tab matches — two tabs in one directory are indistinguishable
 *      this way, and guessing is the thing to avoid.
 *
 * Note neither route is "the focused tab". Focus is a different question and
 * answers `false` for a background tab running this command.
 */
export function resolveIdentity(opts: {
  sessionId?: string
  tabs: WhoamiTab[]
  /** Tab the terminal matched to our process tree, if any. */
  currentTabId?: string
  /** Project slug holding `sessionId`'s transcript, if it was found on disk. */
  sessionSlug?: string
  /** Maps a tab cwd to its project slug (injected so this stays pure). */
  slugOf?: (cwd: string) => string
  origin?: { backend?: string; configDir?: string }
}): WhoamiIdentity {
  const { sessionId, tabs, currentTabId, sessionSlug, slugOf, origin } = opts

  const base: WhoamiIdentity = {
    tab: null,
    tabId: null,
    sessionId: sessionId ?? null,
    cwd: null,
    worktree: null,
    via: null,
    ...(origin?.backend ? { backend: origin.backend } : {}),
    ...(origin?.configDir ? { configDir: origin.configDir } : {}),
  }

  const found = (tab: WhoamiTab, via: 'pid' | 'session-slug'): WhoamiIdentity => ({
    ...base,
    tab: tab.name,
    tabId: tab.tabId,
    cwd: tab.cwd ?? null,
    worktree: worktreeOf(tab.cwd),
    color: tab.color,
    via,
  })

  if (currentTabId) {
    const hit = tabs.find((t) => t.tabId === currentTabId)
    if (hit) return found(hit, 'pid')
  }

  if (sessionSlug && slugOf) {
    const matches = tabs.filter((t) => t.cwd && slugOf(t.cwd) === sessionSlug)
    if (matches.length === 1) return found(matches[0], 'session-slug')
  }

  return base
}
