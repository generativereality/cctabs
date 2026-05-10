import { define } from 'gunshi'
import { requireAdapter } from '../core/adapter.js'

export const sessionsCommand = define({
  name: 'sessions',
  description: 'List tabs with active/idle session status',
  args: {},
  async run() {
    const adapter = requireAdapter()
    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const currentTab = adapter.currentTabId()
    const currentWs = adapter.currentWorkspaceId()

    console.log('Sessions')
    console.log('='.repeat(50))

    for (const wsp of workspaces) {
      const { oid, name, tabids } = wsp.workspacedata
      const wsMarker = oid === currentWs ? ' (current)' : ''
      const tabIds = tabids.filter((t) => tabsById.has(t))
      if (!tabIds.length) continue

      console.log(`\nWorkspace: ${name}${wsMarker}`)

      for (const tabId of tabIds) {
        const termBlocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
        if (!termBlocks.length) continue

        const name = tabNames.get(tabId) ?? tabId.slice(0, 8)
        const cur = tabId === currentTab ? ' ◄' : ''
        const b = termBlocks[0]
        const cwd = (b.meta?.['cmd:cwd'] ?? '').replace(process.env.HOME ?? '', '~')

        const status = adapter.detectSessionStatus(b.blockid)

        const statusLabel =
          status === 'active' ? '● active'
          : status === 'idle' ? '○ idle'
          : status === 'unknown' ? '? unknown'
          : '  terminal'

        console.log(`  [${tabId.slice(0, 8)}] "${name}"${cur}  ${cwd}`)
        console.log(`    ${statusLabel}`)
        if (status === 'terminal') {
          const tail = adapter.scrollback(b.blockid, 5)
          const lastLine = tail.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
          if (lastLine) console.log(`    last: ${lastLine.slice(0, 80)}`)
        }
      }
    }
  },
})
