import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { define } from 'gunshi'
import { consola } from 'consola'
import * as p from '@clack/prompts'
import {
  WAVE_DB_PATH,
  backupWaveDb,
  findOrphanTabIds,
  removeOrphanTabIds,
  type OrphanReport,
} from '../core/wave-db.js'
import { detectTerminal, type KnownTerminal } from '../core/terminal.js'

type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'

interface CheckResult {
  name: string
  status: CheckStatus
  detail?: string
  hint?: string
}

const STATUS_GLYPH: Record<CheckStatus, string> = {
  ok: '✔',
  warn: '⚠',
  fail: '✘',
  skip: '–',
}

function printResult (r: CheckResult): void {
  const glyph = STATUS_GLYPH[r.status]
  const line = `  ${glyph}  ${r.name}${r.detail ? ' — ' + r.detail : ''}`
  console.log(line)
  if (r.hint) console.log(`       ↳ ${r.hint}`)
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkTerminal (terminal: KnownTerminal): CheckResult {
  if (terminal === 'wave' || terminal === 'tabby') {
    return { name: 'Terminal', status: 'ok', detail: terminal }
  }
  return {
    name: 'Terminal',
    status: 'fail',
    detail: terminal === 'unknown' ? 'unrecognised' : terminal,
    hint: 'cctabs supports Wave Terminal and Tabby. Switch to one of those.',
  }
}

function checkWaveAccessibility (): CheckResult {
  // We can't introspect the macOS TCC.db without an admin prompt. The next
  // best thing is to trigger a no-op AppleScript that requires Accessibility:
  // sending an empty key event to Wave will fail loudly when permission is
  // missing. Run it with a 2s deadline so we don't hang.
  const r = spawnSync(
    'osascript',
    ['-e', 'tell application "System Events" to count processes'],
    { encoding: 'utf-8', timeout: 2000 },
  )
  const stderr = (r.stderr ?? '').trim()
  if (r.status === 0) {
    return { name: 'Wave Accessibility permission', status: 'ok' }
  }
  if (stderr.includes('not allowed') || stderr.includes('1002') || stderr.includes('-1719')) {
    return {
      name: 'Wave Accessibility permission',
      status: 'fail',
      detail: 'osascript denied',
      hint: 'System Settings → Privacy & Security → Accessibility → enable Wave Terminal',
    }
  }
  return {
    name: 'Wave Accessibility permission',
    status: 'warn',
    detail: stderr || `osascript exit ${r.status}`,
    hint: 'Could not verify automatically. If `cctabs new` errors, check Privacy & Security → Accessibility.',
  }
}

interface TabbyHealth { ok: boolean; version?: string; raw?: string; error?: string }

function probeTabbyPlugin (host: string, port: number): TabbyHealth {
  const r = spawnSync(
    'curl',
    ['-fsS', '--max-time', '3', `http://${host}:${port}/api/health`],
    { encoding: 'utf-8' },
  )
  if (r.status !== 0 || !r.stdout) {
    return { ok: false, error: (r.stderr || '').trim() || `exit ${r.status}` }
  }
  try {
    const parsed = JSON.parse(r.stdout) as { ok: boolean; version?: string }
    return { ok: !!parsed.ok, version: parsed.version, raw: r.stdout }
  } catch {
    return { ok: false, error: 'non-JSON response', raw: r.stdout }
  }
}

function checkTabbyPlugin (): CheckResult {
  const host = process.env.CCTABS_TABBY_HOST ?? '127.0.0.1'
  const port = Number(process.env.CCTABS_TABBY_PORT ?? '3300')
  const health = probeTabbyPlugin(host, port)
  if (health.ok) {
    return {
      name: 'Tabby cctabs plugin',
      status: 'ok',
      detail: `${host}:${port}, version ${health.version ?? 'unknown'}`,
    }
  }
  return {
    name: 'Tabby cctabs plugin',
    status: 'fail',
    detail: `${host}:${port} unreachable (${health.error ?? 'unknown'})`,
    hint:
      'Run `cctabs install-tabby-plugin` from inside a Tabby tab — it npm-installs the plugin and reopens Tabby. ' +
      'Or do it by hand: `npm install --legacy-peer-deps --prefix "$HOME/Library/Application Support/tabby/plugins" tabby-cctabs`, then quit + reopen Tabby.',
  }
}

interface WaveDbCheck {
  result: CheckResult
  reports?: OrphanReport[]
}

function checkWaveDb (): WaveDbCheck {
  if (!existsSync(WAVE_DB_PATH)) {
    return {
      result: {
        name: 'Wave DB',
        status: 'skip',
        detail: 'not found — Wave Terminal not installed?',
      },
    }
  }
  let reports: OrphanReport[]
  try {
    reports = findOrphanTabIds()
  } catch (err) {
    return {
      result: {
        name: 'Wave DB orphan-tabid scan',
        status: 'fail',
        detail: (err as Error).message,
        hint: 'sqlite3 CLI must be on PATH (ships with macOS by default).',
      },
    }
  }
  if (!reports.length) {
    return {
      result: {
        name: 'Wave DB orphan-tabid scan',
        status: 'ok',
        detail: 'no orphans',
      },
    }
  }
  return {
    result: {
      name: 'Wave DB orphan-tabid scan',
      status: 'warn',
      detail: `${reports.length} workspace(s) affected`,
      hint: "Run `cctabs doctor --fix` (after quitting Wave) to clean up.",
    },
    reports,
  }
}

// ---------------------------------------------------------------------------
// Wave-DB fix flow (unchanged logic, factored out)
// ---------------------------------------------------------------------------

async function fixWaveDb (
  reports: OrphanReport[],
  yes: boolean,
): Promise<void> {
  console.log('')
  consola.warn(`${reports.length} workspace(s) with orphan tabids:`)
  for (const r of reports) {
    console.log(`  • "${r.workspaceName}" [${r.workspaceId.slice(0, 8)}]`)
    console.log(`      present: ${r.presentTabIds.length} tab(s)`)
    console.log(`      orphan : ${r.orphanTabIds.length} tabid(s) → ${r.orphanTabIds.map((t) => t.slice(0, 8)).join(', ')}`)
  }
  console.log('')
  console.log("These tabids point at rows that no longer exist in db_tab. Wave's")
  console.log("BlocksList RPC aborts on the first missing tab, so `wsh blocks list`")
  console.log("currently fails with: \"couldn't list blocks for workspace …: not found\".")
  console.log('')
  console.log('Fix steps:')
  console.log('  1. Copy the Wave DB to a timestamped backup next to it.')
  console.log("  2. For each affected workspace, rewrite `data.tabids` to drop the orphan IDs.")
  console.log("  3. Leave Wave's db_tab untouched.")
  console.log('')
  console.log('IMPORTANT: Quit Wave Terminal first — otherwise Wave may overwrite the')
  console.log('fix on its next save. (Cmd+Q on the Wave app, then re-run this command.)')
  console.log('')

  let proceed = yes
  if (!yes) {
    const ans = await p.confirm({ message: 'Apply the fix now?', initialValue: false })
    if (p.isCancel(ans)) { consola.info('Cancelled.'); return }
    proceed = Boolean(ans)
  }
  if (!proceed) { consola.info('Aborted. No changes made.'); return }

  const backup = backupWaveDb()
  consola.success(`Backup written: ${backup}`)

  for (const r of reports) {
    try {
      removeOrphanTabIds(r)
      consola.success(`Cleaned "${r.workspaceName}" [${r.workspaceId.slice(0, 8)}] — removed ${r.orphanTabIds.length} orphan tabid(s)`)
    } catch (err) {
      consola.error(`Failed to clean ${r.workspaceId}: ${(err as Error).message}`)
      consola.info(`Restore from backup if anything looks wrong: cp ${JSON.stringify(backup)} ${JSON.stringify(WAVE_DB_PATH)}`)
      process.exit(1)
    }
  }
  consola.success('All orphan tabids removed. Start Wave Terminal again and re-run `cctabs sessions`.')
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const doctorCommand = define({
  name: 'doctor',
  description: 'Run environment checks (terminal detection, plugin reachability, Wave DB orphan scan, Wave Accessibility) and offer fixes for known problems.',
  args: {
    yes: { type: 'boolean', short: 'y', description: 'Apply the fix without an interactive confirmation prompt' },
    fix: { type: 'boolean', description: 'Apply available fixes (currently: Wave DB orphan-tabids)' },
  },
  async run(ctx) {
    const yes = Boolean(ctx.values.yes)
    const fix = Boolean(ctx.values.fix) || yes

    const terminal = detectTerminal()

    console.log('cctabs doctor — environment checks')
    console.log('─'.repeat(40))

    const results: CheckResult[] = []
    let waveDb: WaveDbCheck | null = null

    results.push(checkTerminal(terminal))

    if (terminal === 'tabby') {
      results.push(checkTabbyPlugin())
    }

    if (terminal === 'wave') {
      results.push(checkWaveAccessibility())
      waveDb = checkWaveDb()
      results.push(waveDb.result)
    } else if (existsSync(WAVE_DB_PATH)) {
      // Wave is installed but we're not running in it — still useful to scan
      // the DB so users diagnose orphan-tabid bugs from any terminal.
      waveDb = checkWaveDb()
      results.push({ ...waveDb.result, name: 'Wave DB orphan-tabid scan (offline)' })
    }

    for (const r of results) printResult(r)

    const failed = results.some(r => r.status === 'fail')
    const orphans = waveDb?.reports ?? []
    if (orphans.length && fix) {
      await fixWaveDb(orphans, yes)
    } else if (orphans.length) {
      console.log('')
      consola.info('Re-run with `cctabs doctor --fix` to clean up orphan tabids (a DB backup is made first).')
    }

    if (failed) process.exit(1)
  },
})
