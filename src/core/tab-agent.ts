import { classifyTerminalBuffer } from './session-status.js'
import type { TerminalAdapter } from './adapter.js'
import type { AllData } from '../types/index.js'
import { readProcessTable, matchTabsToClaude } from './claude-procs.js'
import { matchCodexTabs, readCodexSessions } from './codex-sessions.js'
import { codexStatus } from './codex.js'
import { codexIdentities, rememberCodex } from './codex-state.js'
import { suspendedTabsIn } from './suspend-ops.js'

/** A Codex verdict never falls through to a Claude transcript lookup. */
export function tabAgent(adapter: TerminalAdapter, data: AllData, tabId: string, rows = readProcessTable(), sessions = readCodexSessions()) {
  const blocks = data.tabsById.get(tabId) ?? [], b = blocks.find((b) => b.view === 'term')
  const name = data.tabNames.get(tabId) ?? '', cwd = b?.meta?.['cmd:cwd'] ?? ''
  const tabs = [...data.tabsById].flatMap(([id, blocks]) => {
    const term = blocks.find((b) => b.view === 'term')
    return term ? [{ tabId: id, name: data.tabNames.get(id) ?? '', cwd: term.meta?.['cmd:cwd'], shellPid: term.shellPid }] : []
  })
  const claude = matchTabsToClaude(tabs, rows ?? []).get(tabId)
  if (claude?.via === 'shell-pid') return { engine: 'claude' as const, cwd }
  const suspended = suspendedTabsIn(adapter, data, rows).get(tabId)?.record
  if (suspended?.engine === 'codex') return { engine: 'codex' as const, id: suspended.sessionId, cwd: suspended.dir }
  if (suspended) return { engine: 'claude' as const, cwd: suspended.dir }
  const live = matchCodexTabs(tabs, rows ?? [], sessions).get(tabId)
  if (live) {
    const dir = live.proc.cwd || cwd || live.session?.cwd || ''
    if (live.id) rememberCodex({ id: live.id, name, cwd: dir, tabId, pid: live.proc.pid })
    return { engine: 'codex' as const, id: live.id, cwd: dir }
  }
  const buffer = b ? adapter.scrollback(b.blockid, 80) : ''
  if (b && codexStatus(buffer) !== undefined) return { engine: 'codex' as const, cwd }
  const cached = codexIdentities().filter((r) => r.tabId === tabId && r.name === name)
  if (cached.length === 1) return { engine: 'codex' as const, id: cached[0].id, cwd: cached[0].cwd }
  if (claude) return { engine: 'claude' as const, cwd }
  const status = classifyTerminalBuffer(buffer)
  if (status === 'active' || status === 'idle') return { engine: 'claude' as const, cwd }
  return { engine: 'unknown' as const, cwd }
}
