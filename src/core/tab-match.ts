/**
 * Shared tab-name matching used by every adapter's `resolveTab`.
 *
 * Lives here rather than being copy-pasted per adapter so the matching rules —
 * especially the exact-only mode below, which restore/resume depend on for
 * correctness — can't drift between Wave and Tabby.
 */

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
