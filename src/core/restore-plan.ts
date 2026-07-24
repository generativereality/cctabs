import type { SessionStatus } from '../types/index.js'

/**
 * Planning half of `cctabs restore`.
 *
 * Restore has two entry points — an explicit `--manifest` and a bare
 * `cctabs restore [dir]` that scans the window's own tabs — but only one set of
 * decisions to make. Both funnel their input into `RestoreEntry[]` and run it
 * through `planRestore`, so attach/spawn/skip/close is decided in exactly one
 * place.
 *
 * Everything here is READ-ONLY by construction: planning never mutates a tab.
 * That is what makes `--dry` trustworthy — a dry run executes the same planner
 * against the same live terminal state and prints the same decisions a real run
 * would act on, rather than a separate, more optimistic guess.
 */

export interface RestoreEntry {
  /** Tab title / Claude session `--name`. */
  name: string
  /**
   * Directory to resume in. Manifest entries carry it; scan entries carry it
   * only when the user scoped the restore to a directory. When absent, the
   * session lookup determines the directory.
   */
  dir?: string
  /** Session id (possibly a prefix) recorded in a manifest. */
  sessionId?: string
  /**
   * Scan mode only: the existing tab this entry was derived from. A bound entry
   * belongs to that one tab and skips name→tab resolution, which is what lets
   * two dead tabs sharing a name be told apart (one restored, the extra closed)
   * instead of collapsing into a single ambiguous match.
   */
  tabId?: string
}

export type RestoreAction =
  /** The tab we're running in already satisfies this entry. */
  | 'current-tab'
  /** A live Claude is already in the matching tab. */
  | 'already-running'
  /** More than one tab matches the name. */
  | 'ambiguous'
  /** The matching tab has no terminal in it. */
  | 'no-terminal'
  /** A tab exists but no session could be found to resume in it. */
  | 'no-session'
  /** Send `claude --resume` into the matching tab's live shell. */
  | 'attach'
  /** The matching tab's shell is gone — close it and spawn a replacement. */
  | 'recreate'
  /** An earlier entry already claimed this name; close this leftover dead tab. */
  | 'duplicate'
  /** No tab exists — create one. */
  | 'spawn'
  /** No tab exists and --create-missing wasn't passed. */
  | 'missing'

export interface PlannedEntry {
  entry: RestoreEntry
  action: RestoreAction
  /** Existing tab this entry resolved to, when there is one. */
  tabId?: string
  /** Terminal block within `tabId`. */
  blockId?: string
  /**
   * Tab to close as part of executing this entry: the dead tab being replaced
   * ('recreate') or the redundant duplicate ('duplicate'). Never set for an
   * entry whose tab is owned by a different entry.
   */
  closeTabId?: string
  /** Session to resume; absent on a 'spawn' means start a fresh Claude. */
  sessionId?: string
  /** Directory Claude must be launched from. */
  dir?: string
}

/** Session lookup result: the id to resume and the directory to resume it in. */
export interface ResolvedSession {
  id: string
  dir: string
}

export interface PlanDeps {
  /** Tab cctabs itself is running in ('' when unknown). */
  currentTabId: string
  /** Tab ids in scope (the current workspace). */
  scopeTabIds: Set<string>
  /** Name → matching tab ids. Must be exact-name matching (see tab-match.ts). */
  matchTabs(name: string): string[]
  /** First terminal block in a tab, if any. */
  termBlockOf(tabId: string): string | undefined
  statusOf(blockId: string): SessionStatus
  /**
   * Read-only re-check that a terminal with no readable scrollback really is
   * dead rather than merely slow to report. Only called for 'unknown' tabs.
   */
  confirmEmpty(blockId: string): Promise<boolean>
  /** Find the session to resume for an entry, or null when there is none. */
  resolveSession(entry: RestoreEntry): ResolvedSession | null
  /** Whether entries with no existing tab may be spawned. */
  createMissing: boolean
}

/** Actions that leave a tab running this entry's session. */
const KEEPS_TAB: ReadonlySet<RestoreAction> = new Set<RestoreAction>([
  'current-tab',
  'already-running',
  'attach',
  'recreate',
  'spawn',
])

/**
 * Decide what to do with every entry. Pure with respect to the terminal: it
 * only reads tab state (including the async, still read-only, empty-scrollback
 * confirmation) and returns decisions for the caller to execute — or, under
 * --dry, to print and discard.
 */
export async function planRestore(
  entries: RestoreEntry[],
  deps: PlanDeps,
): Promise<PlannedEntry[]> {
  // Pass 1 (sync): resolve each entry to a tab and read that tab's status.
  interface Pending {
    entry: RestoreEntry
    early?: RestoreAction
    tabId?: string
    blockId?: string
    status?: SessionStatus
  }

  const pending: Pending[] = entries.map((entry) => {
    const inScope = (tid: string) => deps.scopeTabIds.has(tid)

    // A bound (scan-mode) entry is about one specific tab; an unbound
    // (manifest) entry has to find its tab by name.
    const allMatches = entry.tabId
      ? (inScope(entry.tabId) ? [entry.tabId] : [])
      : deps.matchTabs(entry.name).filter(inScope)

    // The current tab can't be replaced — we're running inside it. Filtering it
    // out below would make an entry naming it look "missing", and
    // --create-missing would then spawn a duplicate of the very tab driving the
    // restore.
    if (allMatches.length === 1 && allMatches[0] === deps.currentTabId) {
      return { entry, early: 'current-tab', tabId: deps.currentTabId }
    }

    const matches = allMatches.filter((tid) => tid !== deps.currentTabId)
    if (matches.length > 1) return { entry, early: 'ambiguous' }
    if (matches.length === 0) return { entry }

    const tabId = matches[0]
    const blockId = deps.termBlockOf(tabId)
    if (!blockId) return { entry, early: 'no-terminal', tabId }

    const status = deps.statusOf(blockId)
    if (status === 'active' || status === 'idle') {
      return { entry, early: 'already-running', tabId, blockId }
    }
    return { entry, tabId, blockId, status }
  })

  // Pass 2 (parallel): confirm the 'unknown'-status tabs really are dead.
  // confirmEmpty sleeps between polls, so overlapping them costs ~one poll
  // window in total rather than one per tab.
  const emptyByBlock = new Map<string, boolean>()
  await Promise.all(
    pending
      .filter((p) => !p.early && p.status === 'unknown' && p.blockId)
      .map(async (p) => {
        emptyByBlock.set(p.blockId!, await deps.confirmEmpty(p.blockId!))
      }),
  )

  // Pass 3 (sync): resolve sessions and settle on an action, claiming names as
  // we go so a name is only ever restored once.
  //
  // `claimedNames` covers every entry that ends up owning a tab for that name,
  // including ones we merely leave alone — a dead tab must not be restored into
  // a second copy of a session that is already live somewhere in the bar.
  // `restoredNames` is the narrower set we're willing to CLOSE a leftover tab
  // for: only when this restore actively brought that name back up.
  const claimedNames = new Set<string>()
  const restoredNames = new Set<string>()
  const claimedTabs = new Set<string>()
  const planned: PlannedEntry[] = []

  for (const p of pending) {
    const { entry } = p

    if (p.early) {
      const out: PlannedEntry = { entry, action: p.early, tabId: p.tabId, blockId: p.blockId }
      // A tab that stays put still owns its name, so a later duplicate entry
      // can't restore over it.
      if (KEEPS_TAB.has(p.early)) {
        claimedNames.add(entry.name)
        if (p.tabId) claimedTabs.add(p.tabId)
      }
      planned.push(out)
      continue
    }

    // Someone else already has this name. A scan entry bound to its own
    // leftover dead tab is closed, but only when the name was actually restored
    // — a dead tab shadowed by an already-running one is reported and left for
    // the user, since nothing here put that session back on screen.
    if (claimedNames.has(entry.name) || (p.tabId && claimedTabs.has(p.tabId))) {
      const ownsTab = !!entry.tabId && p.tabId === entry.tabId && !claimedTabs.has(p.tabId)
      planned.push({
        entry,
        action: 'duplicate',
        tabId: p.tabId,
        blockId: p.blockId,
        closeTabId: ownsTab && restoredNames.has(entry.name) ? p.tabId : undefined,
      })
      continue
    }

    const session = deps.resolveSession(entry)

    if (p.tabId) {
      // Existing tab: without a session there's nothing to resume into it.
      if (!session) {
        planned.push({ entry, action: 'no-session', tabId: p.tabId, blockId: p.blockId })
        continue
      }
      claimedNames.add(entry.name)
      restoredNames.add(entry.name)
      claimedTabs.add(p.tabId)
      // No live shell to send to — the tab has to be rebuilt around the resume.
      const dead = p.status === 'unknown' && emptyByBlock.get(p.blockId!) === true
      planned.push({
        entry,
        action: dead ? 'recreate' : 'attach',
        tabId: p.tabId,
        blockId: p.blockId,
        closeTabId: dead ? p.tabId : undefined,
        sessionId: session.id,
        dir: session.dir,
      })
      continue
    }

    // No tab at all.
    if (!deps.createMissing) {
      planned.push({ entry, action: 'missing', sessionId: session?.id, dir: session?.dir ?? entry.dir })
      continue
    }
    claimedNames.add(entry.name)
    restoredNames.add(entry.name)
    // A spawn with no session starts a fresh Claude, which is still a restore
    // of the tab itself — the manifest asked for it to exist.
    planned.push({
      entry,
      action: 'spawn',
      sessionId: session?.id,
      dir: session?.dir ?? entry.dir,
    })
  }

  return planned
}

/**
 * Work out the tab order to rebuild after execution.
 *
 * Recreated and spawned tabs are appended to the end of the bar, so without
 * this a restore comes back scrambled. Two shapes, one function:
 *
 *   - Scan mode passes `baseOrder` (the full pre-restore tab order, including
 *     live tabs, the current tab, and anything restore didn't touch) and the
 *     order is that list with each replaced tab id swapped for its replacement.
 *   - Manifest mode passes no `baseOrder`; the manifest itself carries the
 *     desired order, so it's just each entry's final tab id in manifest order.
 *
 * `replacements` maps a pre-restore tab id to the tab that replaced it; ids
 * mapped to null (closed duplicates) drop out entirely.
 */
export function buildDesiredOrder(
  finalTabIds: Array<string | undefined>,
  replacements: Map<string, string | null>,
  baseOrder?: string[],
): string[] {
  if (baseOrder) {
    const out: string[] = []
    for (const id of baseOrder) {
      if (!replacements.has(id)) {
        out.push(id)
        continue
      }
      const replacement = replacements.get(id)
      if (replacement) out.push(replacement)
    }
    return out
  }
  return finalTabIds.filter((id): id is string => !!id)
}
