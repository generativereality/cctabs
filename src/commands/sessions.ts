import { define } from 'gunshi'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabSession } from '../core/session.js'
import { classifyTerminalBuffer, parsePermissionMode } from '../core/session-status.js'

/**
 * Rows of captured output to read per tab.
 *
 * One read serves everything: the status classification, the mode pill, and
 * the last line. 200 rows covers Claude Code's full footer, which renders with
 * blank padding below the prompt.
 */
const BUFFER_ROWS = 200

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
        /**
         * Permission mode read from the session's own footer, so `restore` can
         * put the tab back the way it was instead of in whatever the global
         * `claude.flags` dictate. Omitted when the tab couldn't be read.
         */
        permission_mode?: string
        /**
         * The tab's colour, so `restore --manifest` can put it back. Restore
         * recreates a dead tab rather than reviving it, and a fresh tab starts
         * uncoloured — so unlike Tabby's own tab recovery, this has to be
         * carried explicitly. Omitted when the plugin doesn't report colours.
         */
        color?: string | null
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
          // One read, three answers — see BUFFER_ROWS.
          const buffer = adapter.scrollback(b.blockid, BUFFER_ROWS)
          const status = classifyTerminalBuffer(buffer)
          const permissionMode = parsePermissionMode(buffer)
          const lastLine = buffer.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''

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
            ...(b.color !== undefined ? { color: b.color } : {}),
            ...(permissionMode ? { permission_mode: permissionMode } : {}),
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
