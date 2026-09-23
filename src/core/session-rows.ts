import type { TerminalAdapter } from './adapter.js'
import { resolveTabSession } from './session.js'
import { classifyTerminalBuffer, parsePermissionMode } from './session-status.js'
import { countSessionsInDir, locateTranscriptFile } from './transcript.js'
import { classifySessionLookup, type SessionLookup } from './session-lookup.js'
import {
  launchedSessionOf,
  matchTabsToClaude,
  type ProcMatchVia,
  type ProcRow,
} from './claude-procs.js'

/**
 * Rows of captured output to read per tab.
 *
 * One read serves everything: the status classification, the mode pill, and
 * the last line. 200 rows covers Claude Code's full footer, which renders with
 * blank padding below the prompt.
 */
const BUFFER_ROWS = 200

/** One tab, as `cctabs sessions --json` reports it. */
export interface SessionRow {
  block_id: string
  tab_id: string
  name: string
  cwd: string
  current: boolean
  status: string
  last_line: string
  session_id: string | null
  /**
   * Whether `session_id` is absent because we looked and found nothing,
   * or because we couldn't look — see {@link SessionLookup}. Always
   * present, so a caller never has to infer it from a bare null.
   */
  session_lookup: SessionLookup
  /**
   * Where `session_id` came from: the by-title transcript search, or — only
   * when that found nothing — the `--resume` in the argv of the Claude running
   * in this tab. Absent when there is no id.
   */
  session_source?: 'transcript' | 'argv'
  /**
   * For `session_lookup: "not-found"`: how many transcripts exist for
   * this tab's directory under any title. `> 0` means the tab was
   * renamed out from under a live session rather than having none.
   */
  sessions_in_dir?: number
  /** For `session_lookup: "lookup-failed"`: what went wrong. */
  session_lookup_error?: string
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
  /** The Claude process running in this tab, when one could be matched. */
  claude_pid?: number
  /** How `claude_pid` was matched — see {@link ProcMatchVia}. */
  claude_pid_via?: ProcMatchVia
}

export interface WorkspaceRow {
  id: string
  name: string
  current: boolean
  sessions: SessionRow[]
}

/**
 * Build the `sessions --json` view of every terminal tab.
 *
 * `procRows` is the process table, or null when there is none to read (then
 * no argv fallback happens and no pids are reported — the transcript answers
 * alone, exactly as before).
 */
export async function collectSessionRows(
  adapter: TerminalAdapter,
  procRows: ProcRow[] | null,
): Promise<WorkspaceRow[]> {
  const { tabsById, workspaces, tabNames } = await adapter.getAllData()
  const currentTab = adapter.currentTabId()
  const currentWs = adapter.currentWorkspaceId()

  const procsByTab = procRows
    ? matchTabsToClaude(
        [...tabsById.entries()].flatMap(([tabId, blocks]) => {
          const term = blocks.find((b) => b.view === 'term')
          return term ? [{ tabId, name: tabNames.get(tabId) ?? tabId.slice(0, 8), shellPid: term.shellPid }] : []
        }),
        procRows,
      )
    : new Map()

  const out: WorkspaceRow[] = []

  for (const wsp of workspaces) {
    const { oid, name: wsName, tabids } = wsp.workspacedata
    const tabIds = tabids.filter((t) => tabsById.has(t))
    if (!tabIds.length) continue

    const wsRow: WorkspaceRow = { id: oid, name: wsName, current: oid === currentWs, sessions: [] }

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
      let source: SessionRow['session_source']
      // Which Claude account the session belongs to. Emitted so the
      // manifest round-trips: a session living in a backend's own
      // CLAUDE_CONFIG_DIR can't be resumed without it.
      let backend: string | undefined
      let configDir: string | undefined
      // The failure is captured rather than swallowed: a lookup that threw
      // is reported as `lookup-failed`, which is not the same answer as
      // "this tab has no session" and must not be flattened into it.
      let lookupError: Error | undefined
      if (cwd) {
        try {
          const resolved = resolveTabSession(cwd, tabName)
          if (resolved) {
            sessionId = resolved.id
            sessionDir = resolved.dir
            backend = resolved.backend
            configDir = resolved.configDir
            source = 'transcript'
          }
        } catch (err) {
          lookupError = err as Error
        }
      }

      // Before reporting "no session": ask the process. A live Claude launched
      // with `--resume <id>` names its session exactly, and the title search
      // has two measured blind spots — a renamed worktree (the transcript sits
      // under the old slug) and an on-disk title that no longer matches the tab.
      // Only the id is taken from argv; the name stays the tab's.
      const tabProc = procsByTab.get(tabId)
      if (!sessionId && tabProc) {
        const launched = launchedSessionOf(tabProc.proc)
        if (launched) {
          sessionId = launched
          source = 'argv'
          const located = locateTranscriptFile(launched)
          backend = located?.backend
          configDir = located?.configDir
          lookupError = undefined
        }
      }

      const lookup = classifySessionLookup({
        cwd,
        found: sessionId !== null,
        error: lookupError,
        countInDir: () => countSessionsInDir(cwd),
      })

      wsRow.sessions.push({
        block_id: b.blockid,
        tab_id: tabId,
        name: tabName,
        cwd: sessionDir,
        current: tabId === currentTab,
        status,
        last_line: lastLine.slice(0, 200),
        session_id: sessionId,
        session_lookup: lookup.status,
        ...(source ? { session_source: source } : {}),
        ...(lookup.sessionsInDir !== undefined ? { sessions_in_dir: lookup.sessionsInDir } : {}),
        ...(lookup.detail ? { session_lookup_error: lookup.detail } : {}),
        ...(b.color !== undefined ? { color: b.color } : {}),
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
        ...(backend ? { backend } : {}),
        ...(configDir ? { config_dir: configDir } : {}),
        ...(tabProc ? { claude_pid: tabProc.proc.pid, claude_pid_via: tabProc.via } : {}),
      })
    }

    out.push(wsRow)
  }

  return out
}
