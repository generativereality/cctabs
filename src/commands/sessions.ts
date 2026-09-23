import { define } from 'gunshi'
import { requireAdapter } from '../core/adapter.js'
import { classifyTerminalBuffer, parsePermissionMode } from '../core/session-status.js'
import { collectSessionRows } from '../core/session-rows.js'
import { readProcessTable } from '../core/claude-procs.js'

/** Rows of captured output to read per tab — see session-rows.ts. */
const BUFFER_ROWS = 200

export const sessionsCommand = define({
  name: 'sessions',
  description: 'List tabs with active/idle session status',
  args: {
    json: { type: 'boolean', short: 'j', description: 'Emit machine-readable JSON. Output can be piped to `cctabs restore --manifest -` on another machine.' },
  },
  async run(ctx) {
    const adapter = requireAdapter()
    const asJson = (ctx.values.json as boolean | undefined) ?? false

    if (asJson) {
      const workspaceRows = await collectSessionRows(adapter, readProcessTable())
      adapter.closeSocket?.()
      console.log(JSON.stringify({ workspaces: workspaceRows }, null, 2))
      return
    }

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

        const buffer = adapter.scrollback(b.blockid, BUFFER_ROWS)
        const status = classifyTerminalBuffer(buffer)
        const permissionMode = parsePermissionMode(buffer)

        const statusLabel =
          status === 'active' ? '● active (turn in flight)'
          : status === 'idle' ? '○ idle (waiting for input)'
          : status === 'unreadable' ? '? unreadable'
          : '  terminal'

        console.log(`  [${tabId.slice(0, 8)}] "${name}"${cur}  ${cwd}`)
        console.log(`    ${statusLabel}${permissionMode ? `  ·  ${permissionMode}` : ''}`)
        // An unreadable tab is the one case where the status line alone would
        // mislead, so say what we do know: whether a process is running in it.
        if (status === 'unreadable') {
          console.log(
            b.pid
              ? `    no output captured, but pid ${b.pid} is running — open it to see`
              : '    no output captured and no process — the shell is gone',
          )
        }
        if (status === 'terminal') {
          const lastLine = buffer.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
          if (lastLine) console.log(`    last: ${lastLine.slice(0, 80)}`)
        }
      }
    }
  },
})
