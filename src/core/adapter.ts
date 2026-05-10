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
