import { define } from 'gunshi'
import { requireWaveAdapter } from '../core/wave.js'

export const listCommand = define({
  name: 'list',
  description: 'List all workspaces, tabs, and blocks',
  args: {},
  async run() {
    const adapter = requireWaveAdapter()
    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const currentBlock = process.env.WAVETERM_BLOCKID ?? ''
    const currentTab = process.env.WAVETERM_TABID ?? ''
    const currentWs = process.env.WAVETERM_WORKSPACEID ?? ''

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
        console.log(`  Tab  "${tabName}"  [${tabId.slice(0, 8)}]${cur}`)
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
