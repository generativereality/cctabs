import { existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import * as p from '@clack/prompts'
import {
  WAVE_DB_PATH,
  backupWaveDb,
  findOrphanTabIds,
  removeOrphanTabIds,
} from '../core/wave-db.js'
import { detectTerminal } from '../core/terminal.js'

export const doctorCommand = define({
  name: 'doctor',
  description: 'Diagnose Wave Terminal DB issues (orphan tabids that abort `wsh blocks list`) and offer to fix them.',
  args: {
    yes: { type: 'boolean', short: 'y', description: 'Apply the fix without an interactive confirmation prompt' },
    fix: { type: 'boolean', description: 'Apply the fix (otherwise diagnose only)' },
  },
  async run(ctx) {
    const yes = Boolean(ctx.values.yes)
    const fix = Boolean(ctx.values.fix) || yes

    const terminal = detectTerminal()
    if (terminal !== 'wave' && terminal !== 'unknown') {
      consola.info(`cctabs doctor diagnoses Wave Terminal’s SQLite DB. You’re running in ${terminal} — nothing to fix here.`)
      return
    }

    consola.info(`Wave DB: ${WAVE_DB_PATH}`)
    if (!existsSync(WAVE_DB_PATH)) {
      consola.error('Wave Terminal DB not found at the expected path. Is Wave installed?')
      process.exit(1)
    }

    let reports
    try {
      reports = findOrphanTabIds()
    } catch (err) {
      consola.error('Failed to inspect Wave DB via sqlite3:', (err as Error).message)
      consola.info('Make sure the `sqlite3` CLI is on your PATH (it ships with macOS by default).')
      process.exit(1)
    }

    if (!reports.length) {
      consola.success('No orphan tabids found. Wave DB looks healthy.')
      return
    }

    consola.warn(`Found ${reports.length} workspace(s) with orphan tabids:`)
    for (const r of reports) {
      console.log(`  • "${r.workspaceName}" [${r.workspaceId.slice(0, 8)}]`)
      console.log(`      present: ${r.presentTabIds.length} tab(s)`)
      console.log(`      orphan : ${r.orphanTabIds.length} tabid(s) → ${r.orphanTabIds.map((t) => t.slice(0, 8)).join(', ')}`)
    }
    console.log('')
    console.log('These tabids point at rows that no longer exist in db_tab. Wave\'s')
    console.log("BlocksList RPC aborts on the first missing tab, so `wsh blocks list`")
    console.log("currently fails with: \"couldn't list blocks for workspace …: not found\".")
    console.log('')

    if (!fix) {
      consola.info('Re-run with `cctabs doctor --fix` to apply the surgical fix (a backup will be made).')
      return
    }

    console.log('The fix:')
    console.log('  1. Copy the Wave DB to a timestamped backup next to it.')
    console.log('  2. For each affected workspace, rewrite `data.tabids` to drop the orphan IDs.')
    console.log('  3. Leave Wave\'s db_tab untouched.')
    console.log('')
    console.log('IMPORTANT: Quit Wave Terminal first — otherwise Wave may overwrite the')
    console.log('fix on its next save. (Cmd+Q on the Wave app, then re-run this command.)')
    console.log('')

    let proceed = yes
    if (!yes) {
      const ans = await p.confirm({
        message: 'Apply the fix now?',
        initialValue: false,
      })
      if (p.isCancel(ans)) {
        consola.info('Cancelled.')
        return
      }
      proceed = Boolean(ans)
    }
    if (!proceed) {
      consola.info('Aborted. No changes made.')
      return
    }

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
  },
})
