import type { TerminalAdapter } from './adapter.js'
import type { Block } from '../types/index.js'

/**
 * A resolved send/read target: the terminal block to talk to, plus whatever we
 * know about the tab it belongs to.
 *
 * The tab fields are what separates this from a bare block id. `transcript`
 * needs the tab's NAME and CWD to find the Claude session running in it — a
 * block id says nothing about which conversation is inside — and those two are
 * exactly what `resolveTabSession` takes. They're absent when the query only
 * matched a block, which is the honest answer: a block that isn't in a tab we
 * can name has no session we can resolve.
 */
export interface TabTarget {
  blockId: string
  tabId?: string
  name?: string
  cwd?: string
}

export type TabTargetResult =
  | { ok: true; target: TabTarget }
  /** `lines` are the candidate list printed under `message` for an ambiguous query. */
  | { ok: false; message: string; lines?: string[] }

/**
 * Resolve a user-typed target — tab name, tab id prefix, or block id prefix —
 * the one way, for every command that takes one.
 *
 * `send`, `scrollback` and `transcript` each carried a verbatim copy of this
 * (tab first, block as fallback, same two ambiguity messages), which is three
 * places for the resolution order to drift. The order matters: tab names are
 * what a human types and what `cctabs sessions` prints, so a name that is also
 * a block-id prefix must still resolve to the tab.
 */
export function resolveTabTarget(
  adapter: TerminalAdapter,
  query: string,
  tabsById: Map<string, Block[]>,
  tabNames: Map<string, string>,
): TabTargetResult {
  const tabMatches = adapter.resolveTab(query, tabsById, tabNames)

  if (tabMatches.length > 1) {
    return {
      ok: false,
      message: `Multiple tabs match '${query}':`,
      lines: tabMatches.map((tid) => `  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`),
    }
  }

  if (tabMatches.length === 1) {
    const tabId = tabMatches[0]
    const blocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
    if (!blocks.length) {
      return { ok: false, message: `Tab "${tabNames.get(tabId)}" has no terminal block` }
    }
    return {
      ok: true,
      target: {
        blockId: blocks[0].blockid,
        tabId,
        name: tabNames.get(tabId) ?? tabId.slice(0, 8),
        cwd: blocks[0].meta?.['cmd:cwd'],
      },
    }
  }

  const blockMatches = adapter.resolveBlock(query, adapter.blocksList())
  if (!blockMatches.length) {
    return {
      ok: false,
      message: `No tab or block matching '${query}' (tabs in workspaces with no open window are not visible — open that workspace first)`,
    }
  }
  if (blockMatches.length > 1) {
    return {
      ok: false,
      message: `Multiple blocks match '${query}':`,
      lines: blockMatches.map((b) => `  ${b.blockid}`),
    }
  }

  const b = blockMatches[0]
  return { ok: true, target: { blockId: b.blockid, tabId: b.tabid, cwd: b.meta?.['cmd:cwd'] } }
}
