import { Injectable } from '@angular/core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TabRegistry } from './tab-registry'

/**
 * Snapshot of `pid → tabUuid` for every terminal tab known to the registry.
 *
 * Built lazily — `lookup(pids)` rebuilds the index on every call so we never
 * miss a freshly-spawned child process. The index isn't kept in memory between
 * calls because tab process trees can change rapidly.
 */
@Injectable({ providedIn: 'root' })
export class PidIndex {
  constructor (private tabs: TabRegistry) {}

  /**
   * Return the UUID of the tab that owns any of the given PIDs (the caller's
   * ancestor chain). Returns `undefined` if no match.
   */
  async lookup (pids: number[]): Promise<string | undefined> {
    const candidate = new Set(pids)

    for (const { uuid, tab } of this.tabs.entries()) {
      if (!(tab instanceof BaseTerminalTabComponent)) continue
      const session = (tab as any).session
      if (!session) continue

      // The shell PID is the PTY's truePID. tabby-local Session keeps the
      // pty as a private field; reach into it directly. Falls back to
      // tabby-mcp-style getChildProcesses (matches descendant pids only).
      try {
        const pty: any = session.pty
        if (pty && typeof pty.getTruePID === 'function') {
          const truePid: number = await pty.getTruePID()
          if (typeof truePid === 'number' && candidate.has(truePid)) return uuid
        }
      } catch {
        // pty not ready — try children below
      }

      try {
        const children: Array<{ pid: number }> =
          typeof session.getChildProcesses === 'function'
            ? await session.getChildProcesses()
            : []
        for (const c of children) {
          if (candidate.has(c.pid)) return uuid
        }
      } catch {
        // session not ready or platform doesn't support it — try next tab
      }
    }
    return undefined
  }
}
