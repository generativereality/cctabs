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

    // Pass 1: the PTY's own pid. It is the tab's shell and lives as long as the
    // tab does, so every process in the tab has it as an ancestor — an exact
    // answer. truePID is NOT that: Tabby computes it once, two seconds after
    // spawn, and for a `zsh -c claude` tab it lands on a short-lived helper that
    // is gone five minutes later (see `stable-pid` in server.ts). A dead truePID
    // can be recycled by the OS into someone's ancestor chain, so it only gets
    // a say once no tab has matched exactly.
    for (const { uuid, tab } of this.tabs.entries()) {
      if (!(tab instanceof BaseTerminalTabComponent)) continue
      try {
        const pty: any = (tab as any).session?.pty
        if (pty && typeof pty.getPID === 'function') {
          const shellPid: number = await pty.getPID()
          if (typeof shellPid === 'number' && candidate.has(shellPid)) return uuid
        }
      } catch {
        // pty not ready — the fallbacks below may still answer
      }
    }

    // Pass 2: the old heuristics, for a pty that can't report its own pid.
    for (const { uuid, tab } of this.tabs.entries()) {
      if (!(tab instanceof BaseTerminalTabComponent)) continue
      const session = (tab as any).session
      if (!session) continue

      // tabby-local Session keeps the pty as a private field; reach into it
      // directly. Falls back to tabby-mcp-style getChildProcesses (matches
      // descendant pids of truePID only).
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
