import { spawn, spawnSync } from 'child_process'
import { closeSync, mkdirSync, openSync, readlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import { detectTerminal } from '../core/terminal.js'
import { readProcessTable } from '../core/claude-procs.js'
import { resolveTabShell, tabLaunchArgv, shellQuoteArg } from '../core/shell.js'
import { gatherManifest, manifestJson, reportManifest } from './manifest.js'
import { withoutInvalid } from '../core/fleet-manifest.js'
import {
  checkCapture, defaultSuspendAge, restorableEntries, fleetDir, readPending, stampedManifestPath, tabbyLifecycle,
  tabbyLaunchEnv, tabbyMainPids, tasklistShowsTabby, writePending, type PendingReason, type Platform,
} from '../core/fleet-state.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function platformOrExit(): Platform {
  const p = process.platform
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p
  consola.error(`Restarting Tabby isn't supported on ${p}.`)
  process.exit(1)
}

/**
 * Save the fleet, check the save, and close every tab but this one.
 * Shared by `restart-tabby` and `prepare-reboot`; returns the caller's tab id.
 */
export async function saveAndClose(
  adapter: TerminalAdapter,
  opts: { reason: PendingReason; yes: boolean; suspendOlderThan?: string; allRunning?: boolean; then: string },
): Promise<string> {
  const selfTab = adapter.currentTabId()
  if (!selfTab) {
    consola.error('cctabs could not tell which Tabby tab it is running in, so it cannot keep this one open. Run it from inside a Tabby tab.')
    process.exit(1)
  }

  // -- save --
  // The calling session is kept in: it ends with Tabby too, and comes back in
  // the restore like every other.
  const { result, rows } = await gatherManifest(adapter, { includeSelf: true })
  const liveTabIds = adapter.blocksList().filter((b) => b.view === 'term').map((b) => b.tabid)
  const errors = result.problems.filter((p) => p.severity === 'error').map((p) => `${p.name}: ${p.message}`)
  const check = checkCapture({ capturedTabIds: rows.map((r) => r.tab_id), liveTabIds, errors })
  reportManifest(result)
  if (!check.ok) {
    consola.error(check.message)
    process.exit(1)
  }
  const entries = restorableEntries(withoutInvalid(result))
  const noSession = result.problems.filter((p) => p.code === 'no-session').map((p) => p.name)
  const manifestPath = stampedManifestPath(new Date())
  mkdirSync(fleetDir(), { recursive: true })
  writeFileSync(manifestPath, manifestJson(entries))
  const withSession = entries.length
  const suspendAge = opts.allRunning ? undefined : (opts.suspendOlderThan ?? defaultSuspendAge(withSession))

  const others = [...new Set(liveTabIds)].filter((t) => t !== selfTab)
  consola.success(`Saved ${withSession} session(s) → ${manifestPath}`)
  if (noSession.length) consola.warn(`${noSession.length} tab(s) have no Claude session and won't come back: ${noSession.join(', ')}`)
  consola.info(
    `Then: close the ${others.length} other tab(s) by id, ${opts.then}` +
    (suspendAge ? ` Sessions idle for more than ${suspendAge} come back suspended (they wake on Enter or \`cctabs send\`); --all-running to start every one.` : ''),
  )

  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      // An agent, most likely. The question is the user's to answer.
      consola.error(`Not closing anything without a confirmation, and there is no terminal to ask in. Confirm with the user, then run again with --yes. The save is kept at ${manifestPath}.`)
      process.exit(1)
    }
    const ok = await consola.prompt('Proceed?', { type: 'confirm', initial: false })
    if (ok !== true) {
      consola.info(`Nothing closed. The save is kept at ${manifestPath}.`)
      process.exit(0)
    }
  }

  writePending({
    manifest: manifestPath,
    savedAt: new Date().toISOString(),
    reason: opts.reason,
    sessions: withSession,
    ...(suspendAge ? { suspendOlderThan: suspendAge } : {}),
    noSession,
  })

  // -- close, by id --
  for (const tabId of others) {
    try { adapter.deleteBlock(tabId) } catch (err) { consola.warn(`Closing ${tabId.slice(0, 8)}: ${(err as Error).message}`) }
  }
  // Checked against the terminal's own list, not taken on trust.
  const deadline = Date.now() + 60_000
  let left = others
  while (Date.now() < deadline) {
    try {
      const now = new Set(adapter.blocksList().map((b) => b.tabid))
      left = others.filter((t) => now.has(t))
      if (!left.length) break
    } catch { /* a slow read is not an answer; keep waiting */ }
    await sleep(1000)
  }
  if (left.length) {
    consola.error(`${left.length} tab(s) are still open: ${left.map((t) => t.slice(0, 8)).join(', ')}. The fleet is saved and marked pending; close them, then carry on.`)
    process.exit(1)
  }
  consola.success(`Closed ${others.length} tab(s). Only this one is left.`)
  return selfTab
}

export const restartTabbyCommand = define({
  name: 'restart-tabby',
  description: 'Restart Tabby without losing tabs: save every session, close the other tabs, quit and reopen Tabby, then restore them all in a new tab',
  args: {
    yes: { type: 'boolean', short: 'y', description: 'Skip the confirmation' },
    'suspend-older-than': { type: 'string', description: 'Bring back sessions idle for longer than this suspended (90m, 12h, 3d, 2w). Default: 3d when there are more than 30 sessions.' },
    'all-running': { type: 'boolean', description: 'Bring every session back running, however many' },
  },
  async run(ctx) {
    const platform = platformOrExit()
    if (detectTerminal() !== 'tabby') { consola.error('Run this from inside a Tabby tab.'); process.exit(1) }
    if (platform === 'win32') consola.warn('Restarting Tabby on Windows is new and less tested than on macOS. If Tabby does not come back, start it yourself and run `cctabs restore --pending`.')
    const adapter = requireAdapter()
    const selfTab = await saveAndClose(adapter, {
      reason: 'tabby-restart',
      yes: !!ctx.values.yes,
      suspendOlderThan: ctx.values['suspend-older-than'] as string | undefined,
      allRunning: !!ctx.values['all-running'],
      then: 'close this tab, quit Tabby, reopen it, and restore everything in a new tab.',
    })

    startRestartWorker(selfTab)
  },
})

/**
 * Hand the rest to a detached worker: this process, the Claude that ran it and
 * this tab are all about to go. Detached = its own session (POSIX) / process
 * group (Windows), so the hangup that ends this tab's processes misses it.
 */
export function startRestartWorker(selfTab: string): void {
  mkdirSync(fleetDir(), { recursive: true })
  const log = join(fleetDir(), `restart-${Date.now()}.log`)
  const fd = openSync(log, 'a')
  const child = spawn(process.execPath, [process.argv[1], 'restart-tabby-worker', '--self-tab', selfTab], {
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  closeSync(fd)
  consola.success('Handed over to the restart worker. This tab closes in a few seconds; Tabby reopens with a tab running the restore.')
  consola.info(`Log: ${log}`)
}

export const prepareRebootCommand = define({
  name: 'prepare-reboot',
  description: 'Get ready to restart the computer: save every session and close the other tabs. After the reboot, run `cctabs restore --pending`',
  args: {
    yes: { type: 'boolean', short: 'y', description: 'Skip the confirmation' },
    'suspend-older-than': { type: 'string', description: 'When restoring, bring back sessions idle for longer than this suspended (90m, 12h, 3d, 2w). Default: 3d when there are more than 30 sessions.' },
    'all-running': { type: 'boolean', description: 'When restoring, bring every session back running' },
  },
  async run(ctx) {
    platformOrExit()
    if (detectTerminal() !== 'tabby') { consola.error('Run this from inside a Tabby tab.'); process.exit(1) }
    await saveAndClose(requireAdapter(), {
      reason: 'reboot',
      yes: !!ctx.values.yes,
      suspendOlderThan: ctx.values['suspend-older-than'] as string | undefined,
      allRunning: !!ctx.values['all-running'],
      then: 'and leave this one for you.',
    })
    consola.success('Ready. Restart the computer now. Afterwards, open Tabby and run: cctabs restore --pending')
  },
})

// ---- the detached worker ----

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] ${msg}`)
}

function tabbyRunning(platform: Platform): boolean {
  if (platform === 'win32') {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Tabby.exe', '/NH'], { encoding: 'utf-8' })
    return tasklistShowsTabby(r.stdout ?? '')
  }
  return tabbyMainPids(readProcessTable() ?? [], platform).length > 0
}

/** Where to start Tabby again from, read off the running process. macOS reopens by app name. */
function tabbyExePath(platform: Platform): string | undefined {
  try {
    if (platform === 'win32') {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-Process Tabby -ErrorAction SilentlyContinue | Select-Object -First 1).Path'], { encoding: 'utf-8' })
      return r.stdout?.trim() || undefined
    }
    if (platform === 'linux') {
      const pid = tabbyMainPids(readProcessTable() ?? [], platform)[0]
      return pid ? readlinkSync(`/proc/${pid}/exe`) : undefined
    }
  } catch { /* fall back to the name on PATH */ }
  return undefined
}

async function pluginAnswers(port: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { connection: 'close' }, signal: AbortSignal.timeout(5000) })
    return r.ok
  } catch {
    return false
  }
}

export const restartTabbyWorkerCommand = define({
  name: 'restart-tabby-worker',
  description: '(internal) The detached half of `restart-tabby`. Not for running by hand.',
  args: {
    'self-tab': { type: 'string', description: 'The tab restart-tabby ran in' },
  },
  async run(ctx) {
    const platform = platformOrExit()
    const selfTab = ctx.values['self-tab'] as string | undefined
    const pending = readPending()
    if (!pending) { log('No pending restore — nothing to do.'); process.exit(1) }
    log(`Restarting Tabby for a pending restore of ${pending.sessions} session(s) from ${pending.manifest}`)
    const port = process.env.CCTABS_TABBY_PORT ?? '3300'

    // Let restart-tabby print and exit before its tab goes.
    await sleep(1500)
    const exePath = tabbyExePath(platform)

    // Close the last tab ourselves. Its Claude is a running process, and on
    // quit Tabby asks "is still running. Close?" for any such tab — a dialog
    // that would hold the quit until someone clicks it.
    const adapter = requireAdapter()
    if (selfTab) {
      try { adapter.deleteBlock(selfTab); log(`Closed tab ${selfTab.slice(0, 8)}`) } catch (err) { log(`Closing ${selfTab.slice(0, 8)} failed: ${(err as Error).message}`) }
    }
    // Tabby saves the tab list it reopens with 1s (debounced) after a change.
    // Quit before that and it brings back the tabs just closed, racing the
    // restore with Claudes of its own.
    await sleep(3000)

    const { quit, open } = tabbyLifecycle(platform, exePath)
    log(`Quitting Tabby: ${quit.join(' ')}`)
    spawnSync(quit[0], quit.slice(1), { stdio: 'ignore' })
    const quitBy = Date.now() + 60_000
    while (Date.now() < quitBy && tabbyRunning(platform)) await sleep(500)
    if (tabbyRunning(platform)) {
      log('Tabby is still running after 60s — a dialog may be waiting for an answer. Not reopening it. Quit it yourself, start it again, and run: cctabs restore --pending')
      process.exit(1)
    }
    log('Tabby has exited.')

    await sleep(1000)
    log(`Starting Tabby: ${open.join(' ')}`)
    // Tabby gets a clean environment, never this one — see tabbyLaunchEnv.
    spawn(open[0], open.slice(1), { detached: true, stdio: 'ignore', windowsHide: false, env: tabbyLaunchEnv(process.env, platform) }).unref()
    const upBy = Date.now() + 120_000
    let up = false
    while (Date.now() < upBy && !(up = await pluginAnswers(port))) await sleep(1000)
    if (!up) {
      log('The cctabs plugin did not answer within 120s of starting Tabby. Open a tab yourself and run: cctabs restore --pending')
      process.exit(1)
    }
    log('Plugin is up.')
    // A moment for Tabby to finish its own startup before a tab is added.
    await sleep(2000)

    const shell = resolveTabShell()
    const self = [process.execPath, process.argv[1]]
    const body = shell.posix
      ? `${self.map(shellQuoteArg).join(' ')} restore --pending`
      : `${self.map((s) => `"${s}"`).join(' ')} restore --pending`
    try {
      const fresh = requireAdapter()
      const tab = await fresh.openTabDirect!({ cwd: homedir(), title: 'cctabs restore', command: shell.command, args: tabLaunchArgv(shell, body) })
      log(`Opened the restore tab ${tab.tabId.slice(0, 8)}. Done here.`)
    } catch (err) {
      log(`Could not open the restore tab: ${(err as Error).message}. Open one yourself and run: cctabs restore --pending`)
      process.exit(1)
    }
  },
})
