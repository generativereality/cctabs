/**
 * Shared tab-name matching used by every adapter's `resolveTab`.
 *
 * Lives here rather than being copy-pasted per adapter so the matching rules —
 * especially the exact-only mode below, which restore/resume depend on for
 * correctness — can't drift between adapters.
 */

/**
 * A leading status glyph written by the running process, e.g. Claude Code's
 * `✳ my-tab` while it is working. Kept deliberately narrow: a short run of
 * symbol characters, a space, then the real name.
 */
const STATUS_MARKER = /^[^\p{L}\p{N}\s]{1,3}\s+(?=\S)/u

/**
 * Strip a transient status glyph from a tab title.
 *
 * A Tabby tab with no `customTitle` shows whatever OSC title its process sets,
 * and Claude Code prefixes that title with a spinner glyph while it is busy —
 * so the tab's *identity* flickers between `career-strategy` and
 * `✳ career-strategy` depending on when you look. Everything that matches a tab
 * to a session by name (restore, resume, sort, sessions) silently missed such a
 * tab: `cctabs restore` reported "no session found, skipping" and left it dead.
 */
export function normalizeTabName(raw: string): string {
  return raw.replace(STATUS_MARKER, '').trim()
}

export interface TabMatchOptions {
  /**
   * Match by exact name (or exact id) only, with no prefix fallback.
   *
   * The prefix fallback is a convenience for hand-typed queries (`cctabs send
   * gapm …`), but it is actively wrong when the question being asked is "does a
   * tab for THIS session already exist?". A live tab named `gapminder-login`
   * prefix-matches the query `gapminder`, so `cctabs resume gapminder` saw
   * "already running" and refused to resume a session whose tab wasn't open at
   * all. Callers deciding attach-vs-spawn must pass `exact: true`; callers
   * resolving a user-typed target should not.
   */
  exact?: boolean
}

/**
 * Resolve `query` against the given tab ids. Exact name matches (case
 * insensitive) always win; otherwise, unless `exact` is set, fall back to
 * id-prefix and name-prefix matches.
 */
export function matchTabsByName(
  query: string,
  tabIds: string[],
  tabNames: Map<string, string>,
  opts: TabMatchOptions = {},
): string[] {
  const q = query.toLowerCase()

  const exact = tabIds.filter((tid) => (tabNames.get(tid) ?? '').toLowerCase() === q)
  if (exact.length > 0) return exact

  // A full tab id is an exact match too — keep it working in exact mode so ids
  // stay usable as unambiguous handles.
  if (opts.exact) return tabIds.filter((tid) => tid === query)

  return tabIds.filter((tid) => {
    const name = tabNames.get(tid) ?? ''
    return tid.startsWith(query) || name.toLowerCase().startsWith(q)
  })
}
