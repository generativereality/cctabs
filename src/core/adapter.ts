import type { AllData, Block, SessionStatus, Workspace } from '../types/index.js'
import {
  resolveTerminal,
  printUnsupportedTerminalError,
  printWaveWithdrawnError,
} from './terminal.js'
import { TabbyAdapter } from './tabby.js'
import type { TabMatchOptions } from './tab-match.js'

/**
 * The shared shape every backend adapter presents to the commands layer. New
 * methods should be added here first, then implemented in each adapter.
 *
 * Tabby is the only adapter today; the interface stays in place because it is
 * what a new terminal backend implements (and because the Block / Workspace
 * shape it speaks is now baked into the commands layer). Each Tabby tab maps
 * to a single Block with view='term'.
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
   * CONCURRENCY: only safe to call in parallel when the backend advertises
   * `spawn-waits-for-pty` via backendCapabilities(). Otherwise the backend
   * makes each new tab the active one as it spawns, and a terminal tab only
   * starts its command once it first becomes active — fire N in parallel and
   * the ones that lose activation before their frontend attaches never spawn a
   * process at all. Without that capability, create serially with a settle gap.
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

  /**
   * Capability tokens advertised by the backend, for feature detection.
   *
   * Users routinely run a CLI that is newer than the terminal-side plugin it
   * talks to, so behaviour that depends on a backend fix has to be probed, not
   * assumed. Adapters with no notion of capabilities leave this undefined;
   * callers must treat that as "none".
   *
   * Known tokens:
   *   `spawn-waits-for-pty` — openTabDirect serialises concurrent creates and
   *     only resolves once the new tab's process is actually running, making
   *     parallel spawning safe.
   */
  backendCapabilities?(): Promise<string[]>

  // -- query helpers (pure data manipulation) --
  resolveTab(
    query: string,
    tabsById: Map<string, Block[]>,
    tabNames: Map<string, string>,
    opts?: TabMatchOptions,
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
  // resolveTerminal() (not detectTerminal()) so an SSH session whose
  // TERM_PROGRAM is empty still resolves to Tabby when the plugin answers on
  // this host — the probe only runs in the otherwise-unknown case.
  const terminal = resolveTerminal()
  if (terminal === 'tabby') {
    return new TabbyAdapter()
  }
  if (terminal === 'wave') {
    printWaveWithdrawnError()
    process.exit(1)
  }
  printUnsupportedTerminalError(terminal)
  process.exit(1)
}
