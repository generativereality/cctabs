import { existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { claudeProcsOf, launchedSessionOf, liveSessionPids, ownClaudeProc, readProcessTable } from '../core/claude-procs.js'
import { resolveTabColor, TAB_COLOR_NAMES } from '../core/colors.js'
import { collectSessionRows } from '../core/session-rows.js'
import { toLaunchableMode } from '../core/session-status.js'
import { resolveTabTarget } from '../core/tab-target.js'
import { placeholderShellOrThrow, reportWake, reviveDormant, suspendedTabsIn, suspendTab, wakeSuspendedTab, type WakeTarget } from '../core/suspend-ops.js'

export const suspendCommand = define({
  name: 'suspend',
  description: 'Stop Claude in a tab and leave a placeholder that knows its session. The tab keeps its name and place; it wakes on Enter, on `cctabs resume`/`wake`, or when `cctabs send` targets it. A suspended tab is NOT on remote control (claude.ai / the phone) until woken.',
  args: {
    force: { type: 'boolean', description: 'Suspend even if a turn is in flight (the turn is lost)' },
    color: { type: 'string', short: 'c', description: `Recolour the tab while it is suspended: ${TAB_COLOR_NAMES.join(', ')} or a hex value. Its own colour comes back when cctabs wakes it.` },
  },
  async run(ctx) {
    const queries = ctx.positionals.slice(1)
    if (!queries.length) { consola.error('Usage: cctabs suspend <tab> [<tab>…]'); process.exit(1) }
    const force = !!ctx.values.force

    let suspendedColor: string | null | undefined
    try {
      if (ctx.values.color !== undefined) suspendedColor = resolveTabColor(ctx.values.color as string)
      placeholderShellOrThrow()
    } catch (e) {
      consola.error((e as Error).message)
      process.exit(1)
    }

    const procRows = readProcessTable()
    if (!procRows) {
      consola.error('suspend needs a process table (`ps`) to stop the right Claude and to confirm the placeholder started, and there is none on this platform.')
      process.exit(1)
    }
    const self = ownClaudeProc(procRows)
    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const rows = (await collectSessionRows(adapter, procRows)).flatMap((w) => w.sessions)
    const live = liveSessionPids(procRows)
    const procs = claudeProcsOf(procRows)

    let failed = 0
    for (const query of queries) {
      const fail = (msg: string) => { consola.error(`${query}: ${msg}`); failed++ }

      const resolved = resolveTabTarget(adapter, query, tabsById, tabNames)
      if (!resolved.ok) { fail(resolved.message); for (const l of resolved.lines ?? []) consola.log(l); continue }
      const row = rows.find((r) => r.tab_id === resolved.target.tabId)
      if (!row) { fail('not a terminal tab cctabs can see'); continue }

      if (row.status === 'suspended') { consola.info(`"${row.name}" is already suspended.`); continue }
      if (row.current || (self && row.claude_pid === self.pid)) { fail('that is this session — a Claude cannot suspend itself'); continue }
      if (!row.session_id) { fail(`no session resolved for "${row.name}" (${row.session_lookup}), so there would be nothing to wake into`); continue }
      if (row.status === 'active' && !force) { fail('a turn is in flight — suspending would lose it. Wait for it to finish, or pass --force'); continue }
      if (!row.cwd || !existsSync(row.cwd)) { fail(`its directory ${row.cwd || '(none)'} is gone — a woken Claude could not start there`); continue }

      // Which process to stop. Exact ties only, the same rule as `restart`: a
      // Claude under the tab's own shell, or one launched on this session id.
      let claudePid: number | undefined
      if (row.claude_pid !== undefined && row.claude_pid_via === 'shell-pid') {
        const launched = procs.find((p) => p.pid === row.claude_pid)
        const launchedId = launched ? launchedSessionOf(launched) : undefined
        if (launchedId && launchedId !== row.session_id) {
          fail(`the Claude in this tab was launched on ${launchedId.slice(0, 8)}… but the tab resolves to ${row.session_id.slice(0, 8)}… — not guessing which to keep`)
          continue
        }
        claudePid = row.claude_pid
      } else {
        const byId = live.get(row.session_id) ?? []
        if (byId.length > 1) { fail(`${byId.length} Claude processes are running session ${row.session_id.slice(0, 8)}… — close the extra first`); continue }
        claudePid = byId[0]
      }
      if (claudePid === undefined && (row.status === 'idle' || row.status === 'active' || row.claude_pid !== undefined)) {
        fail('Claude is running here but cannot be tied to a process exactly (update the Tabby plugin for `stable-pid`), so it is left alone')
        continue
      }
      if (claudePid === undefined && row.status === 'unreadable') {
        fail('no Claude and no readable shell in this tab — close it and use `cctabs new <name> --resume <id> --suspended`')
        continue
      }

      try {
        const { tabId, recreated } = await suspendTab(adapter, {
          tabId: row.tab_id,
          blockId: row.block_id,
          name: row.name,
          sessionId: row.session_id,
          dir: row.cwd,
          backend: row.backend,
          configDir: row.config_dir,
          permissionMode: toLaunchableMode(row.permission_mode),
          color: row.color,
          claudePid,
          suspendedColor,
        })
        consola.success(`⏸ "${row.name}" suspended [${tabId.slice(0, 8)}] — session ${row.session_id.slice(0, 8)}…${recreated ? ' (its tab closed with Claude, so a new one was opened)' : ''}`)
      } catch (err) {
        fail((err as Error).message)
      }
    }

    adapter.closeSocket()
    if (failed) process.exit(1)
  },
})

export const wakeCommand = define({
  name: 'wake',
  description: 'Wake a suspended tab and wait until Claude is at a ready prompt (answering the folder-trust dialog and resume picker on the way).',
  args: {
    timeout: { type: 'number', description: 'Seconds to wait for a ready prompt (default: 120)' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    if (!query) { consola.error('Usage: cctabs wake <tab>'); process.exit(1) }
    const adapter = requireAdapter()
    const { tabsById, tabNames, workspaces } = await adapter.getAllData()
    const resolved = resolveTabTarget(adapter, query, tabsById, tabNames)
    if (!resolved.ok) {
      adapter.closeSocket()
      consola.error(resolved.message)
      for (const l of resolved.lines ?? []) consola.log(l)
      process.exit(1)
    }
    const { blockId, tabId, name } = resolved.target
    const susp = tabId ? suspendedTabsIn(adapter, { tabsById, tabNames }, readProcessTable()).get(tabId) : undefined
    if (!susp) {
      adapter.closeSocket()
      consola.info(`"${name ?? query}" is not suspended.`)
      return
    }
    const code = await wakeInPlace(adapter, { blockId, tabId: tabId!, name: name ?? query, record: susp.record }, !!susp.dormant, { workspaces, tabsById }, (ctx.values.timeout as number | undefined) ?? 120)
    adapter.closeSocket()
    if (code) process.exit(code)
  },
})

/** Wake (reviving a dormant tab first) and report. Returns an exit code. */
export async function wakeInPlace(
  adapter: ReturnType<typeof requireAdapter>,
  target: WakeTarget,
  dormant: boolean,
  data: Parameters<typeof reviveDormant>[2],
  timeoutSec = 120,
): Promise<number> {
  if (!target.record.sessionId) {
    consola.error(`"${target.name}" shows the suspended marker, but cctabs has no record of its session. Press Enter in the tab to wake it.`)
    return 1
  }
  try {
    if (dormant) target = await reviveDormant(adapter, target, data)
  } catch (err) {
    consola.error(`Could not wake "${target.name}": ${(err as Error).message}`)
    return 1
  }
  const r = await wakeSuspendedTab(adapter, target, { timeoutMs: timeoutSec * 1000 })
  if (!r.ok) {
    consola.error(`Could not wake "${target.name}": ${r.detail}`)
    return 1
  }
  reportWake(target.name, r)
  return 0
}
