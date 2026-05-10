import { execFileSync, spawnSync } from 'child_process'
import { copyFileSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export const WAVE_DB_PATH = process.env.CCTABS_WAVE_DB_PATH ?? join(
  homedir(),
  'Library',
  'Application Support',
  'waveterm',
  'db',
  'waveterm.db',
)

// wsh emits this when wstore.DBMustGet[*Tab] returns "not found" partway
// through iterating workspace.tabids — see waveterm
// pkg/wshrpc/wshserver/wshserver.go BlocksList (around L925).
export const WSH_ORPHAN_TABID_PATTERN =
  /couldn't list blocks for workspace [0-9a-f-]+: not found/i

export interface OrphanReport {
  workspaceId: string
  workspaceName: string
  presentTabIds: string[]
  orphanTabIds: string[]
}

function sqliteRun(query: string, mode: 'json' | 'list' = 'list'): string {
  return execFileSync(
    'sqlite3',
    ['-readonly', '-bail', `-${mode}`, WAVE_DB_PATH, query],
    { encoding: 'utf-8' },
  ).trim()
}

interface WorkspaceRow {
  oid: string
  name: string | null
  tabids: string
}

/** Inspect every workspace; report any tabids that point at non-existent rows in db_tab. */
export function findOrphanTabIds(): OrphanReport[] {
  if (!existsSync(WAVE_DB_PATH)) return []

  const rawWs = sqliteRun(
    "SELECT oid AS oid, json_extract(data, '$.name') AS name, json_extract(data, '$.tabids') AS tabids FROM db_workspace;",
    'json',
  )
  const tabRows = sqliteRun('SELECT oid FROM db_tab;', 'list')
  const liveTabs = new Set(tabRows.split('\n').map((s) => s.trim()).filter(Boolean))

  const wsRows: WorkspaceRow[] = rawWs ? JSON.parse(rawWs) : []

  const reports: OrphanReport[] = []
  for (const row of wsRows) {
    if (!row.tabids) continue
    let tabids: unknown
    try { tabids = JSON.parse(row.tabids) } catch { continue }
    if (!Array.isArray(tabids)) continue

    const present: string[] = []
    const orphans: string[] = []
    for (const t of tabids) {
      if (typeof t !== 'string') continue
      if (liveTabs.has(t)) present.push(t)
      else orphans.push(t)
    }
    if (orphans.length) {
      reports.push({
        workspaceId: row.oid,
        workspaceName: row.name || row.oid.slice(0, 8),
        presentTabIds: present,
        orphanTabIds: orphans,
      })
    }
  }
  return reports
}

/** Copy the live DB to a timestamped backup next to it. Returns the backup path. */
export function backupWaveDb(): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${WAVE_DB_PATH}.cctabs-backup-${ts}`
  copyFileSync(WAVE_DB_PATH, dest)
  return dest
}

/** Surgically strip orphan tabids from a workspace's tabids array.
 *
 * SQLite's json_remove evaluates each path against the *previous* result, so
 * we delete by descending index — that way each removal doesn't shift later
 * indices out from under us.
 */
export function removeOrphanTabIds(report: OrphanReport): void {
  if (!report.orphanTabIds.length) return

  // Build a new tabids array containing just the present tabs, in original order.
  const newTabids = JSON.stringify(report.presentTabIds)

  // json_set replaces the whole tabids array atomically; safer than chaining
  // many json_remove calls, and trivially idempotent.
  const sql = `UPDATE db_workspace SET data = json_set(data, '$.tabids', json('${newTabids.replace(/'/g, "''")}')) WHERE oid = '${report.workspaceId}';`

  const r = spawnSync('sqlite3', [WAVE_DB_PATH, sql], { encoding: 'utf-8' })
  if (r.status !== 0) {
    throw new Error(
      `sqlite3 update failed (status ${r.status}): ${r.stderr?.trim() || 'unknown error'}`,
    )
  }
}
