import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { ancestorsOf, claudeProcsOf, launchedSessionOf, liveSessionPids, ownClaudeProc, readProcessTable } from '../core/claude-procs.js'
import { parseManifest } from '../core/manifest.js'
import { withoutInvalid } from '../core/fleet-manifest.js'
import { auditRestart, entriesToRestore, planRestart } from '../core/restart-plan.js'
import type { RestoreEntry } from '../core/restore-plan.js'
import { pidAlive } from '../core/tab-exit.js'
import { gatherManifest, manifestJson, reportManifest } from './manifest.js'
import { runRestore, shortId } from './restore.js'

/** Where each restart saves the manifest it acted on, for recovery. */
const RESTARTS_DIR = join(homedir(), '.config', 'cctabs', 'restarts')

/** After the last Claude exits: let each tab's shell reach its prompt, which is what restore attaches to. */
const SHELL_SETTLE_MS = 3000

/** How long the audit waits for every restored session to show up in a process's argv. */
const AUDIT_TIMEOUT_MS = 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const restartCommand = define({
  name: 'restart',
  description: 'Restart Claude in every tab (e.g. to pick up a new Claude Code): snapshot, stop, restore with --resume, then check every session came back. Never stops its own session.',
  args: {
    all: { type: 'boolean', description: 'Restart every tab in the manifest (except this session). Without --all or --only, restart only prints its plan.' },
    only: { type: 'string', description: 'Comma-separated tab names to restart, instead of all of them' },
    dry: { type: 'boolean', short: 'n', description: 'Print the plan — which pid is stopped for which tab — and stop' },
    manifest: { type: 'string', short: 'm', description: 'Drive from this manifest instead of snapshotting the fleet now' },
    'repoint-missing-dirs': { type: 'string', description: 'As for `cctabs manifest`' },
    'drop-invalid': { type: 'boolean', description: 'Leave out entries the manifest check rejects, instead of refusing to start' },
    'kill-timeout': { type: 'string', description: 'Seconds to wait for each Claude to exit after SIGTERM (default: 20)' },
  },
  async run(ctx) {
    const only = (ctx.values.only as string | undefined)?.split(',').map((s) => s.trim()).filter(Boolean)
    const all = !!ctx.values.all
    const dry = !!ctx.values.dry || (!all && !only?.length)
    const killTimeoutMs = Number(ctx.values['kill-timeout'] ?? '20') * 1000
    if (!Number.isFinite(killTimeoutMs) || killTimeoutMs <= 0) {
      consola.error('--kill-timeout must be a positive number of seconds')
      process.exit(1)
    }

    // -- preflight: refuse unless we know exactly which process is us --
    const selfSessionId = process.env.CLAUDE_CODE_SESSION_ID
    const procRows = readProcessTable()
    if (!procRows) {
      consola.error('restart needs a process table (`ps`) to tell which Claude is which, and there is none on this platform.')
      process.exit(1)
    }
    const own = ownClaudeProc(procRows)
    if (!selfSessionId || !own) {
      consola.error(
        'restart refuses to run without identifying its own session: ' +
        (!selfSessionId ? 'CLAUDE_CODE_SESSION_ID is not set' : 'no `claude` process among this process\'s ancestors') +
        '. Run it from inside a Claude Code tab.',
      )
      process.exit(1)
    }
    const selfPids = new Set(ancestorsOf(process.pid, procRows))

    // -- the manifest --
    const adapter = requireAdapter()
    const gathered = await gatherManifest(adapter, {
      repointMissingDirs: (ctx.values['repoint-missing-dirs'] as string | undefined)?.replace(/^~/, homedir()),
    })
    adapter.closeSocket()

    let entries: RestoreEntry[]
    const manifestPath = ctx.values.manifest as string | undefined
    if (manifestPath) {
      if (!existsSync(manifestPath)) {
        consola.error(`Manifest file not found: ${manifestPath}`)
        process.exit(1)
      }
      entries = parseManifest(readFileSync(manifestPath, 'utf-8'))
      const before = entries.length
      entries = entries.filter((e) => e.sessionId !== selfSessionId)
      if (entries.length < before) consola.info('Excluded this session from the given manifest — it cannot restart itself.')
      const ids = new Map<string, string>()
      for (const e of entries) {
        if (!e.sessionId) continue
        const prior = ids.get(e.sessionId)
        if (prior) {
          consola.error(`"${prior}" and "${e.name}" both name session ${shortId(e.sessionId)} — restoring both would put two Claudes on one transcript. Fix the manifest.`)
          process.exit(1)
        }
        ids.set(e.sessionId, e.name)
      }
      // Restore resolves an entry by name, so two with one name come back
      // ambiguous — neither restored, after restart has stopped both.
      const names = new Set<string>()
      for (const e of entries) {
        if (names.has(e.name)) {
          consola.error(`"${e.name}" appears more than once — restore could bring back neither after they are stopped. Fix the manifest.`)
          process.exit(1)
        }
        names.add(e.name)
      }
    } else {
      // With --only, a problem on a tab nobody asked to restart must not block
      // the ones that were asked for.
      const inScope = (name: string) => !only?.length || only.includes(name)
      const scoped = {
        ...gathered.result,
        excluded: gathered.result.excluded.filter((x) => inScope(x.name)),
        problems: gathered.result.problems.filter((p) => inScope(p.name)),
      }
      reportManifest(scoped)
      const errors = scoped.problems.filter((p) => p.severity === 'error')
      if (errors.length && !ctx.values['drop-invalid']) {
        consola.error(`${errors.length} manifest problem(s) — nothing stopped. Fix them, or pass --drop-invalid to leave those tabs alone.`)
        process.exit(1)
      }
      entries = parseManifest(manifestJson(withoutInvalid(gathered.result)))
    }

    if (only?.length) {
      const unknown = only.filter((n) => !entries.some((e) => e.name === n))
      if (unknown.length) {
        consola.error(`Not in the manifest: ${unknown.join(', ')}`)
        process.exit(1)
      }
      entries = entries.filter((e) => only.includes(e.name))
    }

    // Suspended tabs have no Claude to restart, and restoring them would wake
    // them — the opposite of what suspending asked for. They pick up a new
    // Claude Code on their own the next time they wake.
    const asleep = entries.filter((e) => e.suspended)
    if (asleep.length) {
      consola.info(`Suspended, left asleep (they start the current Claude Code when woken): ${asleep.map((e) => e.name).join(', ')}`)
      entries = entries.filter((e) => !e.suspended)
    }

    // -- map entries to processes --
    // Tab → Claude pairings, with the session each tab resolved to.
    const rows = gathered.rows
      .filter((r) => r.claude_pid !== undefined)
      .map((r) => ({ pid: r.claude_pid!, via: r.claude_pid_via!, sessionId: r.session_id ?? undefined }))
    const live = liveSessionPids(procRows)
    const plan = planRestart(entries, {
      liveSessionPids: live,
      shellPidClaude: new Map(rows.filter((r) => r.via === 'shell-pid' && r.sessionId).map((r) => [r.sessionId!, r.pid])),
      nameOnly: new Set(rows.filter((r) => r.via === 'argv-name' && r.sessionId).map((r) => r.sessionId!)),
      selfPids,
      launchedSession: new Map(
        claudeProcsOf(procRows).flatMap((p) => {
          const id = launchedSessionOf(p)
          return id ? [[p.pid, id] as [number, string]] : []
        }),
      ),
    })

    consola.info(`This session: ${own.name ?? '(unnamed)'} [pid ${own.pid}] — excluded.`)
    for (const t of plan.targets) consola.log(`  ${t.entry.name}: stop pid ${t.pids.join(', ')} (${t.via}), then resume ${shortId(t.entry.sessionId)}`)
    for (const e of plan.notRunning) consola.log(`  ${e.name}: not running — restore brings up ${shortId(e.sessionId)}`)
    for (const e of plan.handOnly) consola.warn(`  ${e.name}: its Claude can't be tied to ${shortId(e.sessionId)} (matched only by name, or its argv resumes a different session) — restart it by hand`)
    for (const e of plan.noSession) consola.warn(`  ${e.name}: no session id — left alone, since restarting would lose its context`)
    for (const e of plan.protected) consola.warn(`  ${e.name}: would mean stopping this session's own process tree — left alone`)

    if (dry) {
      if (!all && !only?.length && !ctx.values.dry) {
        consola.info('Plan only. Pass --all to restart all of the above, or --only a,b to pick tabs.')
      }
      return
    }

    // -- save what we are about to act on, before touching anything --
    const toRestore = entriesToRestore(plan)
    mkdirSync(RESTARTS_DIR, { recursive: true })
    const saved = join(RESTARTS_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    writeFileSync(saved, JSON.stringify({ generated_at: new Date().toISOString(), sessions: toRestore.map(toManifestShape) }, null, 2) + '\n')
    consola.info(`Manifest saved: ${saved}  (recover with: cctabs restore --manifest ${saved} -c)`)

    // -- stop --
    const allPids = plan.targets.flatMap((t) => t.pids)
    for (const pid of allPids) {
      if (selfPids.has(pid)) continue // belt and braces: planRestart already refused these
      try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }
    consola.info(`Sent SIGTERM to ${allPids.length} Claude process(es); waiting for them to exit…`)
    const deadline = Date.now() + killTimeoutMs
    while (Date.now() < deadline && allPids.some(pidAlive)) await sleep(250)
    const stuck = new Set(plan.targets.filter((t) => t.pids.some(pidAlive)).map((t) => t.entry))
    if (stuck.size) {
      consola.error(`Still running after ${killTimeoutMs / 1000}s, so not restored: ${[...stuck].map((e) => e.name).join(', ')}`)
      process.exitCode = 1
    }
    await sleep(SHELL_SETTLE_MS)

    // -- restore --
    const restoreSet = entriesToRestore(plan, stuck)
    if (!restoreSet.length) {
      consola.warn('Nothing to restore.')
      return
    }
    const report = await runRestore({ manifest: restoreSet, scopedDir: null, createMissing: true, dryRun: false })
    // A tab restore found suspended was left asleep on purpose; auditing it for
    // a running Claude would report it as lost. Matched by name, not object
    // identity: restore may re-home an entry into a new object, and names are
    // unique here (checked above).
    const leftAsleep = new Set(report?.plan.filter((p) => p.action === 'suspended').map((p) => p.entry.name) ?? [])
    const audited = restoreSet.filter((e) => !leftAsleep.has(e.name))

    // -- audit: every restored session has a Claude launched on its id --
    consola.info('Checking every restored tab is running its own session…')
    const auditDeadline = Date.now() + AUDIT_TIMEOUT_MS
    let audit = auditRestart(audited, liveSessionPids(readProcessTable() ?? []))
    while (audit.missing.length && Date.now() < auditDeadline) {
      await sleep(3000)
      audit = auditRestart(audited, liveSessionPids(readProcessTable() ?? []))
    }
    console.log(`\nRestart audit: ${audit.ok.length} running their session, ${audit.missing.length} missing, ${audit.doubled.length} doubled`)
    if (audit.missing.length) {
      consola.error(
        `No Claude is running these sessions — a tab may look alive but be EMPTY: ${audit.missing.map((e) => `${e.name} (${shortId(e.sessionId)})`).join(', ')}. ` +
        `Re-run: cctabs restore --manifest ${saved} -c`,
      )
      process.exitCode = 1
    }
    if (audit.doubled.length) {
      consola.error(`More than one Claude on one transcript: ${audit.doubled.map((e) => e.name).join(', ')} — close the extra tab.`)
      process.exitCode = 1
    }
  },
})

function toManifestShape(e: RestoreEntry) {
  return {
    name: e.name,
    dir: e.dir,
    ...(e.sessionId ? { session_id: e.sessionId } : {}),
    ...(e.backend ? { backend: e.backend } : {}),
    ...(e.configDir ? { config_dir: e.configDir } : {}),
    ...(e.permissionMode ? { permission_mode: e.permissionMode } : {}),
    ...(e.color !== undefined ? { color: e.color } : {}),
  }
}
