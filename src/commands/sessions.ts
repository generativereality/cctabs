import { define } from 'gunshi'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabSession } from '../core/session.js'

export const sessionsCommand = define({
  name: 'sessions',
  description: 'List tabs with active/idle session status',
  args: {
    json: { type: 'boolean', short: 'j', description: 'Emit machine-readable JSON. Output can be piped to `cctabs restore --manifest -` on another machine.' },
  },
  async run(ctx) {
    const adapter = requireAdapter()
    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const currentTab = adapter.currentTabId()
    const currentWs = adapter.currentWorkspaceId()

    const asJson = (ctx.values.json as boolean | undefined) ?? false

    if (asJson) {
      type SessionRow = {
        block_id: string
        tab_id: string
        name: string
        cwd: string
        current: boolean
        status: string
        last_line: string
        session_id: string | null
        /** Backend preset owning this session's Claude config dir, if any. */
        backend?: string
        /** Non-default CLAUDE_CONFIG_DIR the session lives in, if any. */
        config_dir?: string
      }
      type WorkspaceRow = {
        id: string
        name: string
        current: boolean
        sessions: SessionRow[]
      }
      const out: { workspaces: WorkspaceRow[] } = { workspaces: [] }

      for (const wsp of workspaces) {
        const { oid, name: wsName, tabids } = wsp.workspacedata
        const tabIds = tabids.filter((t) => tabsById.has(t))
        if (!tabIds.length) continue

        const wsRow: WorkspaceRow = {
          id: oid,
          name: wsName,
          current: oid === currentWs,
          sessions: [],
        }

        for (const tabId of tabIds) {
          const termBlocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
          if (!termBlocks.length) continue
          const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
          const b = termBlocks[0]
          const cwd = b.meta?.['cmd:cwd'] ?? ''
          const status = adapter.detectSessionStatus(b.blockid)
          const tail = adapter.scrollback(b.blockid, 5)
          const lastLine = tail.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''

          // Worktree-aware resolution: returns the session id AND the directory
          // Claude must launch from to resume it. For a --worktree tab that dir
          // is the worktree path (not the repo-root shell cwd), so the emitted
          // manifest round-trips through `restore` and resumes the right session.
          let sessionId: string | null = null
          let sessionDir = cwd
          // Which Claude account the session belongs to. Emitted so the
          // manifest round-trips: a session living in a backend's own
          // CLAUDE_CONFIG_DIR can't be resumed without it.
          let backend: string | undefined
          let configDir: string | undefined
          if (cwd) {
            try {
              const resolved = resolveTabSession(cwd, tabName)
              if (resolved) {
                sessionId = resolved.id
                sessionDir = resolved.dir
                backend = resolved.backend
                configDir = resolved.configDir
              }
            } catch {
              // ignore — best-effort lookup
            }
          }

          wsRow.sessions.push({
            block_id: b.blockid,
            tab_id: tabId,
            name: tabName,
            cwd: sessionDir,
            current: tabId === currentTab,
            status,
            last_line: lastLine.slice(0, 200),
            session_id: sessionId,
            ...(backend ? { backend } : {}),
            ...(configDir ? { config_dir: configDir } : {}),
          })
        }

        out.workspaces.push(wsRow)
      }

      adapter.closeSocket?.()
      console.log(JSON.stringify(out, null, 2))
      return
    }

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
          status === 'active' ? '● active (turn in flight)'
          : status === 'idle' ? '○ idle (waiting for input)'
          : status === 'unreadable' ? '? unreadable'
          : '  terminal'

        console.log(`  [${tabId.slice(0, 8)}] "${name}"${cur}  ${cwd}`)
        console.log(`    ${statusLabel}`)
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
          const tail = adapter.scrollback(b.blockid, 5)
          const lastLine = tail.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
          if (lastLine) console.log(`    last: ${lastLine.slice(0, 80)}`)
        }
      }
    }
  },
})
