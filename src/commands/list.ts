import { define } from 'gunshi'
import { requireAdapter } from '../core/adapter.js'
import { readProcessTable } from '../core/claude-procs.js'
import { readCodexSessions } from '../core/codex-sessions.js'
import { contextByTab, contextOfSession, formatContext } from '../core/context-usage.js'
import { suspendedTabsIn } from '../core/suspend-ops.js'

export const listCommand = define({
  name: 'list',
  description: 'List all workspaces, tabs, and blocks',
  args: {},
  async run() {
    const adapter = requireAdapter()
    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const currentBlock = adapter.currentBlockId()
    const currentTab = adapter.currentTabId()
    const currentWs = adapter.currentWorkspaceId()
    const procRows = readProcessTable()
    const codexSessions = readCodexSessions()
    const context = contextByTab(tabsById, tabNames, procRows, codexSessions)
    // A suspended tab has no process to ask, but its registry names the session.
    for (const [tabId, susp] of suspendedTabsIn(adapter, { tabsById, tabNames }, procRows)) {
      const u = susp.record.sessionId ? contextOfSession(susp.record.sessionId, susp.record.engine, codexSessions) : null
      if (u) context.set(tabId, u)
    }

    for (const wsp of workspaces) {
      const { oid, name, tabids } = wsp.workspacedata
      const noWindow = !wsp.windowid ? '  (no window)' : ''
      const wsMarker = oid === currentWs ? '  ◄ current' : noWindow
      console.log(`Workspace: ${name}  [${oid.slice(0, 8)}]${wsMarker}`)
      console.log()

      const tabIds = tabids.filter((t) => tabsById.has(t))
      if (!tabIds.length) {
        console.log('  (no open tabs)')
        console.log()
        continue
      }

      for (const tabId of tabIds) {
        const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
        const cur = tabId === currentTab ? '  ◄' : ''
        const ctx = context.get(tabId)
        console.log(`  Tab  "${tabName}"  [${tabId.slice(0, 8)}]${ctx ? `  ${formatContext(ctx)}` : ''}${cur}`)
        for (const b of tabsById.get(tabId) ?? []) {
          const here = b.blockid === currentBlock ? '  ◄ here' : ''
          const cwd = b.meta?.['cmd:cwd'] ?? ''
          console.log(`    ${b.view.padEnd(8)}  ${b.blockid.slice(0, 8)}${cwd ? `  ${cwd}` : ''}${here}`)
        }
        console.log()
      }
    }
  },
})
