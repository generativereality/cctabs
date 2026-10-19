import type { Block } from '../types/index.js'
import { liveSessionOf, matchTabsToClaude, registeredSessionOf, type ProcRow, type ProcTab } from './claude-procs.js'

/** Every terminal tab, reduced to what process matching needs. Pure. */
export function procTabsOf(tabsById: Map<string, Block[]>, tabNames: Map<string, string>): ProcTab[] {
  return [...tabsById.entries()].flatMap(([tabId, blocks]) => {
    const term = blocks.find((b) => b.view === 'term')
    return term ? [{ tabId, name: tabNames.get(tabId) ?? tabId.slice(0, 8), shellPid: term.shellPid }] : []
  })
}

/**
 * The session the Claude running in `tabId` is on, asked of the process rather
 * than the transcripts. Pure but for the registry read, which is injectable.
 *
 * The answer for a tab the by-title search can't place: one renamed after
 * Claude started (`transcript clerk-dev` failed with "nothing here is titled
 * after this tab, but 48 transcript(s) exist", 2026-10-19, for a tab whose
 * Claude was running fine). `tabs` must be ALL tabs, not just this one —
 * name matching is only trusted when the name is unique among them.
 */
export function liveTabSession(
  tabId: string,
  tabs: ProcTab[],
  rows: ProcRow[] | null,
  registered: (pid: number) => string | undefined = registeredSessionOf,
): { id: string; via: 'registry' | 'argv'; pid: number } | undefined {
  if (!rows) return undefined
  const proc = matchTabsToClaude(tabs, rows).get(tabId)?.proc
  const live = proc && liveSessionOf(proc, registered)
  return live && proc ? { ...live, pid: proc.pid } : undefined
}
