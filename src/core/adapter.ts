import type { AllData, Block, SessionStatus, Workspace } from '../types/index.js'
import { detectTerminal, printUnsupportedTerminalError } from './terminal.js'
import { WaveAdapter } from './wave.js'
import { TabbyAdapter } from './tabby.js'

/**
 * The shared shape every backend adapter (Wave, Tabby, …) presents to the
 * commands layer. New methods should be added here first, then implemented
 * in each adapter.
 *
 * The Block / Workspace types are modelled after Wave's data shape; non-Wave
 * adapters synthesize records that fit the same shape. In particular each
 * Tabby tab maps to a single Block with view='term'.
 */
export interface TerminalAdapter {
  // -- bulk reads / lifecycle --
  getAllData(): Promise<AllData>
  closeSocket(): void
  blocksList(): Block[]

  // -- per-block reads --
  scrollback(blockId: string, lastN?: number): string
  confirmScrollbackEmpty(blockId: string, attempts?: number, intervalMs?: number): Promise<boolean>
  detectSessionStatus(blockId: string): SessionStatus

  // -- mutations --
  deleteBlock(blockId: string): void
  newTab(focusWindowId?: string): Promise<boolean>
  waitForNewBlock(
    beforeIds: Set<string>,
    timeoutMs?: number,
  ): Promise<{ blockId: string; tabId: string } | null>
  renameTab(tabId: string, name: string): Promise<void>
  sendInput(blockId: string, text: string): Promise<unknown>

  /**
   * Optional fast path: create a tab that launches `command args` in `cwd`
   * with `title` already set, and return the new tab's ids *directly* — no
   * newTab() + waitForNewBlock() polling and no separate renameTab(). Adapters
   * whose backend hands back the new tab id synchronously (e.g. Tabby's plugin)
   * implement this; the rest leave it undefined and callers fall back to the
   * newTab()/waitForNewBlock() dance.
   *
   * NOTE: do not invoke this concurrently to create many tabs at once. The
   * backend makes each new tab the active one as it spawns, and a terminal tab
   * only starts its command once it first becomes active — fire N in parallel
   * and all but the last lose activation before they spawn. Create serially.
   */
  openTabDirect?(opts: {
    cwd: string
    title: string
    command: string
    args: string[]
    /** Insert the new tab right after the currently-active tab, not at the end. */
    afterActive?: boolean
  }): Promise<{ blockId: string; tabId: string }>

  /** Reorder the tab bar to match `order` (tab ids); unlisted tabs keep order and sort after. */
  reorderTabs?(order: string[]): Promise<void>

  // -- query helpers (pure data manipulation) --
  resolveTab(
    query: string,
    tabsById: Map<string, Block[]>,
    tabNames: Map<string, string>,
  ): string[]
  resolveBlock(query: string, blocks: Block[]): Block[]
  resolveWorkspace(
    workspaces: Workspace[],
    query: string,
  ): Array<{ data: Workspace['workspacedata']; windowId: string }>

  // -- current-context helpers ("which tab am I running in?") --
  /** Tab the cctabs process is currently running in, or '' if unknown. */
  currentTabId(): string
  /** Block the cctabs process is currently running in, or '' if unknown.
   * On Tabby this is the same as currentTabId (1:1 tab↔block mapping). */
  currentBlockId(): string
  /** Workspace the cctabs process is currently running in, or '' if unknown. */
  currentWorkspaceId(): string
}

/** Returns the adapter that matches the running terminal. Exits with a clear
 * error message if none is supported. */
export function requireAdapter(): TerminalAdapter {
  const terminal = detectTerminal()
  if (terminal === 'wave') {
    return new WaveAdapter()
  }
  if (terminal === 'tabby') {
    return new TabbyAdapter()
  }
  printUnsupportedTerminalError(terminal)
  process.exit(1)
}
