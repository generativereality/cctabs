import { resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByNameGlobally, locateSessionById, resetTitleIndexCache, resolveTabSession } from '../core/session.js'
import { launchEnvFor, resolveBackend } from '../core/backends.js'
import { listClaudeConfigDirs, type ClaudeConfigDir, type ConfigDirScope } from '../core/config-dirs.js'
import { locateTranscriptFile, type LocatedTranscript } from '../core/transcript.js'
import { parseManifest } from '../core/manifest.js'
import {
  planRestore,
  buildDesiredOrder,
  type PlanDeps,
  type PlannedEntry,
  type RestoreEntry,
  type ResolvedSession,
} from '../core/restore-plan.js'
import type { Block, Config } from '../types/index.js'
import { shellQuoteArg } from '../core/shell.js'
import { applyTabColor, resolveColorPreference } from '../core/colors.js'
import { liveSessionPids, readProcessTable, type ProcRow } from '../core/claude-procs.js'
import { pidAlive } from '../core/tab-exit.js'
import { placeholderSessions, readRecords } from '../core/suspend.js'
import { installPlaceholderInShell, openPlaceholderTab, placeholderShellOrThrow, suspendedTabsIn } from '../core/suspend-ops.js'

/**
 * Settle after each direct-spawn recreate when the backend can't guarantee the
 * new tab's process has started before it answers (see the
 * `spawn-waits-for-pty` capability). A freshly created tab only spawns its PTY
 * once it has been the active tab long enough for its terminal frontend to
 * attach, and each new tab steals activation from the previous one — so without
 * this gap the tabs that lose the race never launch Claude at all. One second
 * is comfortably longer than a PTY fork + shell exec.
 *
 * Backends that DO advertise the capability serialise and confirm the spawn
 * themselves, so restore skips both the settle and the serialisation.
 */
const SPAWN_SETTLE_MS = 1000

/** Backend capability that makes parallel tab creation safe. */
const CAP_SPAWN_WAITS_FOR_PTY = 'spawn-waits-for-pty'

function readStdinSync(): string {
  // Synchronous stdin read; restore is one-shot CLI so this is acceptable.
  // Falls back to empty string if stdin is a TTY.
  if (process.stdin.isTTY) return ''
  try {
    return readFileSync(0, 'utf-8')
  } catch {
    return ''
  }
}

export const restoreCommand = define({
  name: 'restore',
  description: 'Resume Claude sessions in terminal-state tabs (e.g. after a reboot). With --manifest, drive from an explicit list and optionally spawn missing tabs.',
  args: {
    dry: { type: 'boolean', short: 'n', description: 'Show what would be resumed without actually doing it' },
    manifest: { type: 'string', short: 'm', description: 'Path to a JSON manifest of {name, dir, session_id?} entries (use "-" for stdin). Accepts cctabs sessions --json output directly.' },
    'create-missing': { type: 'boolean', short: 'c', description: 'When using --manifest, spawn new tabs for entries that have no existing tab' },
    suspended: { type: 'boolean', short: 's', description: 'Bring tabs back SUSPENDED: named, knowing their session, but running a small placeholder instead of Claude. Takes seconds for a whole fleet. A suspended tab wakes on Enter, on `cctabs resume <tab>`, or when `cctabs send` targets it.' },
  },
  async run(ctx) {
    const dryRun = !!(ctx.values.dry as boolean | undefined)
    const manifestPath = ctx.values.manifest as string | undefined
    const createMissing = (ctx.values['create-missing'] as boolean | undefined) ?? false
    const suspended = !!(ctx.values.suspended as boolean | undefined)
    if (suspended) {
      try { placeholderShellOrThrow() } catch (e) { consola.error((e as Error).message); process.exit(1) }
    }

    if (manifestPath) {
      await runRestore({
        manifest: readManifestOrExit(manifestPath),
        scopedDir: null,
        createMissing,
        dryRun,
        suspended,
      })
      return
    }

    if (createMissing) {
      consola.warn('--create-missing has no effect without --manifest; ignoring.')
    }

    const rawDir = ctx.positionals[1]
    await runRestore({
      manifest: null,
      scopedDir: rawDir ? resolve(rawDir.replace(/^~/, homedir())) : null,
      createMissing: false,
      dryRun,
      suspended,
    })
  },
})

function readManifestOrExit(manifestPath: string): RestoreEntry[] {
  let raw: string
  if (manifestPath === '-') {
    raw = readStdinSync()
    if (!raw.trim()) {
      consola.error('--manifest - was given but stdin is empty')
      process.exit(1)
    }
  } else {
    if (!existsSync(manifestPath)) {
      consola.error(`Manifest file not found: ${manifestPath}`)
      process.exit(1)
    }
    raw = readFileSync(manifestPath, 'utf-8')
  }

  let entries: RestoreEntry[]
  try {
    entries = parseManifest(raw)
  } catch (err) {
    consola.error((err as Error).message)
    process.exit(1)
  }
  if (!entries.length) {
    consola.error('Manifest contained no usable entries (need at minimum {name, dir} per entry).')
    process.exit(1)
  }
  consola.info(`Manifest: ${entries.length} entry/entries`)
  return entries
}

export interface RestoreRequest {
  /** Manifest entries, or null to scan the window's own tabs. */
  manifest: RestoreEntry[] | null
  /** Scan mode: restrict session lookups to this directory. */
  scopedDir: string | null
  createMissing: boolean
  dryRun: boolean
  /** Restore every entry that has a session as a suspended placeholder. */
  suspended?: boolean
}

/** What a restore did, for a caller that has to act on it (`restart`). */
export interface RestoreReport {
  plan: PlannedEntry[]
  outcomes: Map<PlannedEntry, RestoreOutcome>
}

/**
 * The one restore implementation.
 *
 * Manifest mode and the bare `cctabs restore [dir]` scan differ only in where
 * their entries come from — everything downstream (resolve → attach → spawn →
 * reorder → summary) is shared, so the two can't drift apart again.
 *
 * `--dry` stops immediately after planning. Planning itself performs no
 * mutations, so a dry run reports exactly the decisions a real run would act on.
 */
export async function runRestore(req: RestoreRequest): Promise<RestoreReport | undefined> {
  const { dryRun } = req
  const adapter = requireAdapter()
  const { tabsById, tabNames, workspaces } = await adapter.getAllData()
  const currentTab = adapter.currentTabId()
  // Read once for planning: which sessions a live Claude is already running.
  const procRows = readProcessTable()

  // Manifest mode restores into the current workspace. The scan restores what
  // it can see.
  let scopeTabIds: Set<string>
  let entries: RestoreEntry[]
  let baseOrder: string[] | undefined

  if (req.manifest) {
    const currentWs = adapter.currentWorkspaceId()
    const currentWsData = workspaces.find((w) => w.workspacedata.oid === currentWs)
    scopeTabIds = currentWsData
      ? new Set(currentWsData.workspacedata.tabids)
      : new Set<string>(tabsById.keys())
    entries = rehomeEntries(req.manifest, listClaudeConfigDirs(), locateTranscriptFile, (m) => consola.warn(m))
    if (req.suspended) entries = entries.map((e) => ({ ...e, suspended: true }))
  } else {
    // Scan: one entry per terminal tab, in bar order, each bound to its tab.
    // Live tabs are included so they're reported and so they claim their name
    // against a same-named empty tab elsewhere in the bar.
    scopeTabIds = new Set<string>()
    entries = []
    baseOrder = []
    for (const wsp of workspaces) {
      for (const tabId of wsp.workspacedata.tabids) {
        baseOrder.push(tabId)
        scopeTabIds.add(tabId)
        if (tabId === currentTab) continue
        if (!(tabsById.get(tabId) ?? []).some((b) => b.view === 'term')) continue
        // Carry the tab's current colour into the entry. After a reboot Tabby
        // has recovered these tabs *with* their colours but with dead shells,
        // and restore replaces a dead tab rather than reviving it — so without
        // this the recreated tab comes back uncoloured.
        const termBlock = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')
        entries.push({
          name: tabNames.get(tabId) ?? tabId.slice(0, 8),
          dir: req.scopedDir ?? undefined,
          tabId,
          color: termBlock?.color,
          ...(req.suspended ? { suspended: true } : {}),
        })
      }
    }
    if (!entries.length) {
      consola.info('No tabs to restore.')
      adapter.closeSocket()
      return undefined
    }
  }

  const plan = await planRestore(
    entries,
    buildPlanDeps(adapter, {
      tabsById,
      tabNames,
      scopeTabIds,
      currentTabId: currentTab,
      createMissing: req.createMissing,
      procRows,
    }),
  )

  const running = plan.filter((p) => p.action === 'already-running')
  if (running.length) {
    consola.info(`Already running: ${running.map((p) => p.entry.name).join(', ')}`)
  }
  const asleep = plan.filter((p) => p.action === 'suspended')
  if (asleep.length) {
    consola.info(`Suspended, left asleep: ${asleep.map((p) => p.entry.name).join(', ')}`)
  }

  const actionable = plan.filter(
    (p) => p.action === 'attach' || p.action === 'recreate' || p.action === 'spawn',
  )
  // Falling back to the configured flags is the right default, but it must not
  // be silent: a tab that was deliberately in plan mode coming back able to
  // bypass permissions is exactly the surprise this reports.
  const withoutMode = actionable.filter((p) => !p.permissionMode)
  if (withoutMode.length) {
    const flags = loadConfig().claude.flags
    consola.warn(
      `${withoutMode.length} of ${actionable.length} tab(s) recorded no permission mode — ` +
      `they will launch with the configured claude.flags (${flags.join(' ') || 'none'}). ` +
      `Modes are captured by \`cctabs sessions --json\`; a scan-mode restore has no live footer to read.`,
    )
  }

  consola.info(`${actionable.length} tab(s) to restore${dryRun ? ' (dry run)' : ''}:`)
  for (const p of plan) {
    // Already-running and suspended tabs are covered by the one-line lists
    // above; repeating them here buries the entries that need a decision.
    if (p.action === 'already-running' || p.action === 'suspended') continue
    consola.log(`  ${p.entry.name} ${describeDecision(p, dryRun)}`)
  }

  const results = new Map<PlannedEntry, string>(plan.map((p) => [p, summarizeDecision(p, dryRun)]))
  const outcomes = new Map<PlannedEntry, RestoreOutcome>(
    plan.map((p) => [p, plannedOutcome(p.action)]),
  )

  if (!dryRun) {
    await executePlan(adapter, plan, results, outcomes, {
      baseOrder,
      blocksOf: (tabId) => (tabsById.get(tabId) ?? []).map((b) => b.blockid),
    })
  }

  adapter.closeSocket()

  console.log('\nRestore summary:')
  for (const p of plan) {
    console.log(`  ${p.entry.name}: ${results.get(p)}`)
  }

  if (dryRun) return { plan, outcomes }

  // The count, from what was verified rather than from what was attempted.
  const acted = plan.filter((p) => plannedOutcome(p.action) !== 'skipped')
  const finalOutcomes = acted.map((p) => outcomes.get(p) ?? 'unverified')
  console.log(`\n${acted.length} tab(s) acted on: ${summarizeOutcomes(finalOutcomes)}`)

  const failed = acted.filter((p) => outcomes.get(p) === 'failed')
  if (failed.length) {
    // Non-zero exit: a caller scripting a fleet restart has to be able to
    // notice, and a restore that lost a tab is not a success.
    consola.error(`${failed.length} tab(s) did not come back: ${failed.map((p) => p.entry.name).join(', ')}`)
    process.exitCode = 1
  }
  const unconfirmed = acted.filter((p) => outcomes.get(p) === 'unverified')
  if (unconfirmed.length) {
    consola.warn(
      `${unconfirmed.length} tab(s) could not be confirmed either way: ${unconfirmed.map((p) => p.entry.name).join(', ')}. ` +
      `Read them with \`cctabs transcript <tab>\` before briefing anything from them.`,
    )
  }
  return { plan, outcomes }
}

/**
 * Correct a manifest entry whose recorded Claude account doesn't hold its
 * session, when another account on this machine does.
 *
 * A manifest's `backend` normally wins over what discovery infers — it is a
 * deliberate statement, and it may name an account whose transcript hasn't
 * reached this machine yet. But measured: a manifest recorded three sessions
 * under an account that held only metadata-only trailers for them, after the
 * conversations had moved to the default account, and restore launched all
 * three into "No conversation found". So the claim is kept only when it can't
 * be checked (no local copy anywhere) or checks out. Pure: lookups injected.
 */
export function rehomeEntries(
  entries: RestoreEntry[],
  dirs: ClaudeConfigDir[],
  locate: (id: string, scope?: ClaudeConfigDir[]) => LocatedTranscript | null,
  warn: (message: string) => void,
): RestoreEntry[] {
  return entries.map((e) => {
    if (!e.sessionId || (!e.backend && !e.configDir)) return e
    const claimed = dirs.find((d) => (e.configDir && d.root === e.configDir) || (e.backend && d.backend === e.backend))
    if (!claimed) return e
    if (locate(e.sessionId, [claimed])) return e
    const actual = locate(e.sessionId)
    if (!actual) return e
    warn(
      `${e.name}: the manifest says ${e.backend ? `backend ${e.backend}` : e.configDir}, but session ` +
      `${e.sessionId.slice(0, 8)}… is only there as a trailer — resuming it from ` +
      `${actual.backend ? `backend ${actual.backend}` : actual.configDir ?? 'the default account'}, where the conversation is`,
    )
    return { ...e, backend: actual.backend, configDir: actual.configDir }
  })
}

/**
 * Wire an adapter up as the planner's read-only view of the terminal.
 *
 * Every dependency here is a read. Dry and real runs share this wiring
 * verbatim, which is what makes `--dry` faithful: the same lookups, the same
 * status probes, the same empty-scrollback confirmations, the same decisions —
 * a dry run simply stops before anything is executed.
 */
export function buildPlanDeps(
  adapter: TerminalAdapter,
  opts: {
    tabsById: Map<string, Block[]>
    tabNames: Map<string, string>
    scopeTabIds: Set<string>
    currentTabId: string
    createMissing: boolean
    /** Which Claude config dirs to search. Defaults to every one on the machine. */
    sessionScope?: ConfigDirScope
    /** The process table, or null/absent where there isn't one to read. */
    procRows?: ProcRow[] | null
  },
): PlanDeps {
  const live = opts.procRows ? liveSessionPids(opts.procRows) : undefined
  // A placeholder waiting on a session holds it as surely as a running Claude
  // does: restoring that session again elsewhere would put two tabs on it, and
  // waking either would start a second Claude on one transcript.
  if (live && opts.procRows) {
    for (const [id, ph] of placeholderSessions(opts.procRows)) {
      if (!ph.woken) live.set(id, [...(live.get(id) ?? []), ph.pid])
    }
  }
  // Tabs that are suspended right now, by positive evidence. A dormant one —
  // registered, but with no placeholder process — is deliberately NOT reported
  // as suspended here: its tab holds nothing wakeable, so the planner must see
  // it for what it is (a dead or bare tab) and recreate it, which
  // `registeredSuspended` turns into recreating it as a placeholder.
  const suspendedNow = suspendedTabsIn(adapter, opts, opts.procRows ?? null)
  const suspendedBlocks = new Set(
    [...suspendedNow].filter(([, m]) => !m.dormant)
      .map(([tabId]) => (opts.tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.blockid)
      .filter(Boolean),
  )
  const registered = new Set(readRecords().map((r) => r.sessionId.toLowerCase()))
  // Whether this backend reports pids at all. Asked of the whole snapshot
  // rather than per tab, so we can tell "this tab has no process" from "this
  // plugin is too old to say" without a capability probe: if any tab reports a
  // pid, the ones that don't are genuinely process-less.
  const reportsPids = [...opts.tabsById.values()]
    .some((blocks) => blocks.some((b) => typeof b.pid === 'number'))

  return {
    currentTabId: opts.currentTabId,
    scopeTabIds: opts.scopeTabIds,
    hasLiveProcess: (tabId) => {
      const blocks = opts.tabsById.get(tabId) ?? []
      // `stable-pid`: the tab's own shell, so alive-or-not is a real answer.
      const shell = blocks.find((b) => typeof b.shellPid === 'number')?.shellPid
      if (shell !== undefined) return pidAlive(shell)
      if (!reportsPids) return undefined
      return blocks.some((b) => typeof b.pid === 'number')
    },
    // Exact-name only: a longer-named live tab (`gapminder-login`) must never
    // be taken as proof that `gapminder`'s tab already exists.
    matchTabs: (name) => adapter.resolveTab(name, opts.tabsById, opts.tabNames, { exact: true }),
    termBlockOf: (tabId) => (opts.tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.blockid,
    statusOf: (blockId) => {
      if (suspendedBlocks.has(blockId)) return 'suspended'
      const status = adapter.detectSessionStatus(blockId)
      // The on-screen marker alone, contradicted by the process table (no
      // placeholder anywhere for that tab), is a stale screen — let the
      // planner treat the tab as the shell it now is.
      return status === 'suspended' && opts.procRows ? 'terminal' : status
    },
    confirmEmpty: (blockId) => adapter.confirmScrollbackEmpty(blockId),
    resolveSession: (entry) => resolveEntrySession(entry, opts.sessionScope),
    ...(live ? { liveSessionPids: (id: string) => live.get(id) ?? [] } : {}),
    createMissing: opts.createMissing,
    registeredSuspended: (id) => registered.has(id.toLowerCase()),
  }
}

/**
 * Find the session an entry should resume, and which Claude config dir it lives
 * in. Every shape reports its origin: a session found in a backend's own config
 * dir has to be relaunched with that backend's env, or `claude --resume <id>`
 * quietly starts a new conversation because the id isn't there.
 *
 * Three shapes, in descending order of confidence:
 *   - an explicit id from a manifest (expanded from a prefix if needed, and
 *     located on disk so its config dir is known even when the manifest didn't
 *     record one);
 *   - a directory, which resolves worktree-aware and newest-first, so a
 *     `--worktree` tab picks its worktree session over a stale repo-root one;
 *   - name only, which searches every project in every config dir and takes the
 *     newest match.
 */
function resolveEntrySession(entry: RestoreEntry, scope?: ConfigDirScope): ResolvedSession | null {
  if (entry.sessionId) {
    const located =
      locateSessionById(entry.sessionId, entry.dir, scope) ?? locateSessionById(entry.sessionId, undefined, scope)
    return {
      id: located?.id ?? entry.sessionId,
      dir: entry.dir ?? process.cwd(),
      backend: located?.backend,
      configDir: located?.configDir,
    }
  }

  if (entry.dir) {
    const hit = resolveTabSession(entry.dir, entry.name, scope)
    return hit ? { id: hit.id, dir: hit.dir, backend: hit.backend, configDir: hit.configDir } : null
  }

  const sessions = findSessionsByNameGlobally(entry.name, scope)
  if (!sessions.length) return null
  const best = sessions[0]
  if (sessions.length > 1) {
    // Say which one won — with several Claude accounts in play, "newest" can
    // mean a different account than the user expected.
    const where = best.backend ? `${best.dir}, backend ${best.backend}` : best.dir
    consola.log(`  ${entry.name} — multiple sessions across projects, picking newest (${where})`)
  }
  return { id: best.id, dir: best.dir, backend: best.backend, configDir: best.configDir }
}

export const shortId = (id?: string) => (id ? `${id.slice(0, 8)}…` : 'fresh')

/**
 * Which Claude account a decision will use, when it isn't the default one.
 * Shown because "resumed the right session under the wrong account" is
 * otherwise indistinguishable from success until you look inside the tab.
 */
export function originNote(p: PlannedEntry): string {
  if (p.backend) return ` [backend: ${p.backend}]`
  if (p.configDir) return ` [config dir: ${p.configDir}]`
  return ''
}

/**
 * The permission mode a decision will relaunch with, when the entry recorded
 * one. Shown because it overrides the configured `claude.flags` for that tab,
 * and a tab silently coming back in a different mode than it was in is the
 * whole reason this is captured.
 */
export function modeNote(p: PlannedEntry): string {
  return p.permissionMode ? ` [mode: ${p.permissionMode}]` : ''
}

/** The per-entry decision line, worded for a dry run or a real one. */
export function describeDecision(p: PlannedEntry, dry: boolean): string {
  switch (p.action) {
    case 'current-tab':
      return '— current tab, already present'
    case 'already-running':
      return '— already running, skipping'
    case 'ambiguous':
      return '— multiple matching tabs, skipping'
    case 'no-terminal':
      return '— no terminal block in tab, skipping'
    case 'no-session':
      return `— no session found${p.entry.dir ? ` in ${p.entry.dir}` : ''}, skipping`
    case 'unreadable':
      return '— could not read this tab, but its process is running; leaving it alone'
    case 'attach':
      return p.suspended
        ? `→ ${dry ? 'would suspend' : 'suspending'} ${shortId(p.sessionId)} into existing tab (placeholder)${originNote(p)}`
        : `→ ${dry ? 'would resume' : 'resuming'} ${shortId(p.sessionId)} in existing tab${originNote(p)}${modeNote(p)}`
    case 'recreate':
      return `→ ${dry ? 'would recreate' : 'recreating'} empty tab (no process) with ${shortId(p.sessionId)} in ${p.dir}${p.suspended ? ', suspended' : ''}${originNote(p)}${modeNote(p)}`
    case 'duplicate':
      return p.closeTabId
        ? `— duplicate empty tab, ${dry ? 'would close' : 'closing'} (already restoring one)`
        : '— duplicate entry, skipping (already restoring one)'
    case 'spawn':
      return `→ ${dry ? 'would spawn' : 'spawning'} new ${p.suspended ? 'SUSPENDED ' : ''}tab in ${p.dir} (${shortId(p.sessionId)})${originNote(p)}${modeNote(p)}`
    case 'missing':
      return '— no existing tab; pass --create-missing to spawn one'
    case 'duplicate-session':
      return `— session ${shortId(p.sessionId)} is already being restored by an earlier entry, skipping`
    case 'session-live':
      return `— session ${shortId(p.sessionId)} is already running (or suspended) in another tab, skipping (a second Claude on one transcript)`
    case 'suspended':
      return '— suspended, leaving it asleep'
  }
}

/** Initial summary text. Execution overwrites it for entries it acts on. */
export function summarizeDecision(p: PlannedEntry, dry: boolean): string {
  switch (p.action) {
    case 'current-tab':
      return 'current tab — already present'
    case 'already-running':
      return 'already running'
    case 'ambiguous':
      return 'ambiguous (multiple tabs)'
    case 'no-terminal':
      return 'no terminal block in tab'
    case 'no-session':
      return 'no matching session'
    case 'unreadable':
      return 'unreadable, process alive — left alone'
    case 'attach':
      return dry ? `dry run: attach ${shortId(p.sessionId)}${originNote(p)}` : 'sent'
    case 'recreate':
      return dry ? `dry run: recreate (${shortId(p.sessionId)})${originNote(p)}` : 'queued for recreate'
    case 'duplicate':
      return p.closeTabId
        ? dry ? 'dry run: close duplicate empty tab' : 'duplicate empty tab — closed'
        : 'duplicate entry — skipped'
    case 'spawn':
      return dry ? `dry run: spawn (${shortId(p.sessionId)})${originNote(p)}` : 'queued for spawn'
    case 'missing':
      return 'missing (skipped, no --create-missing)'
    case 'duplicate-session':
      return `duplicate of session ${shortId(p.sessionId)} — skipped`
    case 'session-live':
      return `session ${shortId(p.sessionId)} already live elsewhere — skipped`
    case 'suspended':
      return 'suspended — left asleep'
  }
}

/**
 * What actually became of one entry. Distinct from the display string so the
 * final count is derived from facts rather than parsed back out of prose.
 *
 * `unverified` is a first-class outcome and not a rounding error: a tab can be
 * up with its process running while its session is not yet confirmable, and
 * calling that either "restored" or "failed" is a lie in one direction or the
 * other. It is the honest third answer.
 */
export type RestoreOutcome = 'restored' | 'failed' | 'unverified' | 'skipped'

/** The outcome an action implies before execution — pending, or never acted on. */
export function plannedOutcome(action: PlannedEntry['action']): RestoreOutcome {
  return action === 'attach' || action === 'recreate' || action === 'spawn'
    ? 'unverified'
    : 'skipped'
}

/**
 * The count line, built from outcomes rather than from hope.
 *
 * The line this replaces read "78 spawned, 0 failed" while one tab was absent
 * entirely and another had come back with no session — a summary computed from
 * "did the spawn call return?", which cannot report a failure that happens
 * after it returns. Every category is printed, including the zeroes, because
 * "0 failed" only means something when it was possible for it to say otherwise.
 */
export function summarizeOutcomes(outcomes: RestoreOutcome[]): string {
  const n = (o: RestoreOutcome) => outcomes.filter((x) => x === o).length
  const parts = [
    `${n('restored')} verified`,
    `${n('unverified')} unconfirmed`,
    `${n('failed')} failed`,
  ]
  const skipped = n('skipped')
  if (skipped) parts.push(`${skipped} not acted on`)
  return parts.join(', ')
}

/** What a post-spawn check found out about one tab. */
export interface SpawnEvidence {
  /** Is the tab still in the tab list at all? */
  tabPresent: boolean
  /** Does it hold a terminal block? */
  hasTermBlock: boolean
  /** Whether a process is running — `undefined` when the backend can't say. */
  hasProcess: boolean | undefined
  /** The session this entry asked to resume, if any. */
  requestedSessionId?: string
  /** The session now resolvable for the tab's name and directory, if any. */
  resolvedSessionId?: string
  /**
   * Whether a live Claude's argv says `--resume <requestedSessionId>`.
   * `undefined` where there is no process table to read.
   */
  launchedLive?: boolean
}

export interface SpawnVerdict {
  outcome: RestoreOutcome
  /** The per-entry line, replacing the optimistic one written at spawn time. */
  note: string
}

/**
 * Judge a spawned tab from what the terminal and the transcripts say afterwards.
 *
 * Pure, because these are the rules that decide whether a restore is reported
 * as successful, and they should be readable and testable without a terminal or
 * a 78-tab fleet. Each branch is a failure that has actually been observed and
 * reported as success.
 */
export function judgeSpawn(e: SpawnEvidence): SpawnVerdict {
  if (!e.tabPresent) {
    return { outcome: 'failed', note: '✘ spawn returned but the tab is not in the tab list' }
  }
  if (!e.hasTermBlock) {
    return { outcome: 'failed', note: '✘ tab exists but has no terminal in it' }
  }
  if (e.hasProcess === false) {
    return { outcome: 'failed', note: '✘ tab exists but nothing is running in it' }
  }

  // A resume that quietly started a NEW conversation is the loss that hurts:
  // the tab looks perfect and the context is gone. It shows up as a different
  // session id now answering to this tab's name.
  if (e.requestedSessionId && e.resolvedSessionId && e.resolvedSessionId !== e.requestedSessionId) {
    return {
      outcome: 'failed',
      note: `✘ came back as a DIFFERENT session (${e.resolvedSessionId.slice(0, 8)}…, asked for ${e.requestedSessionId.slice(0, 8)}…) — it started a fresh conversation instead of resuming, so the context is not restored`,
    }
  }

  // The process was launched on the id we asked for, and nothing on disk
  // contradicts it (the check above). No need to wait for a title to be written.
  if (e.launchedLive && e.requestedSessionId) {
    return {
      outcome: 'restored',
      note: `✔ verified running ${e.requestedSessionId.slice(0, 8)}… (from its process)`,
    }
  }

  if (!e.resolvedSessionId) {
    return {
      outcome: 'unverified',
      note: e.hasProcess
        ? '? running, but no session is on disk for it yet — check it before relying on its context'
        : '? tab is there; neither its process nor its session could be confirmed',
    }
  }

  return {
    outcome: 'restored',
    note: `✔ verified running ${e.resolvedSessionId.slice(0, 8)}…`,
  }
}

/**
 * How long a Claude launched on the requested id must stay alive before that
 * counts as proof. Measured: three tabs were reported "✔ verified running …
 * (from its process)" by a check that saw `claude --resume <id>` in the process
 * table — and every one of them printed "No conversation found with session
 * ID" and exited a second later, because its session was in a different Claude
 * account. A process that has appeared proves the launch, not the resume.
 */
export const LAUNCH_SUSTAIN_MS = 6000

/** What the process table has shown for one entry across verification rounds. */
export interface LaunchObservation {
  /** Is a Claude launched on the id running now? `undefined`: no process table. */
  live: boolean | undefined
  /** When it was first seen running in the current unbroken stretch. */
  firstSeenAt?: number
  /** Was it ever seen running during this verification? */
  everSeen: boolean
  now: number
  /** Last round before the deadline: a verdict is required. */
  final: boolean
  /** Recent screen text, only to explain a failure — never to decide one. */
  screen?: string
}

export type LaunchJudgement =
  | { state: 'ok' }
  | { state: 'wait' }
  | { state: 'unknown' }
  | { state: 'failed'; note: string }

/**
 * Has the Claude this entry launched actually stayed up? Pure.
 *
 * The screen never decides it: a tab resumed in place still carries the old
 * "No conversation found" in its scrollback above a healthy Claude. It is only
 * quoted when the process is gone, to say why.
 */
export function judgeLaunch(o: LaunchObservation, sessionId: string): LaunchJudgement {
  if (o.live === undefined) return { state: 'unknown' }
  if (o.live) {
    const sustained = o.firstSeenAt !== undefined && o.now - o.firstSeenAt >= LAUNCH_SUSTAIN_MS
    return sustained || o.final ? { state: 'ok' } : { state: 'wait' }
  }
  const why = o.screen && /No conversation found/.test(o.screen)
    ? ` — Claude said "No conversation found": session ${sessionId.slice(0, 8)}… is not in the Claude account it was launched under`
    : ''
  if (o.everSeen) return { state: 'failed', note: `✘ Claude started on ${sessionId.slice(0, 8)}… and then exited${why}` }
  if (o.final) return { state: 'failed', note: `✘ no Claude running ${sessionId.slice(0, 8)}… after ${VERIFY_DEADLINE_MS / 1000}s${why}` }
  return { state: 'wait' }
}

/**
 * How long to let a freshly spawned tab settle before verifying it.
 *
 * Two things have to have happened: the process has to exist (immediate when
 * the backend advertises `spawn-waits-for-pty`, a second or so otherwise), and
 * Claude has to have written its `custom-title` line, which is what makes the
 * session findable by name. Too short a wait turns healthy tabs into
 * `unconfirmed`, which is noise; this is deliberately generous because the
 * check runs once for the whole fleet, not once per tab.
 */
const VERIFY_SETTLE_MS = 4000

/**
 * How long verification keeps re-checking an entry that isn't confirmed yet.
 *
 * Measured: a restore under load (load average 35–65, 50+ Claude processes)
 * reported a tab as "did not come back" that was running, with `--resume`,
 * the whole time — a single look at 4s saw no process for a tab whose PTY had
 * not attached yet, and the plugin itself only waits 20s for that. So nothing
 * is declared failed before this has passed, and the check re-reads every few
 * seconds rather than once.
 */
const VERIFY_DEADLINE_MS = 45_000
const VERIFY_POLL_MS = 3000

/** Initial wait before the first attach check. */
const ATTACH_SETTLE_MS = 10_000

/** Carry out a plan. Only ever called for a real (non-dry) run. */
async function executePlan(
  adapter: TerminalAdapter,
  plan: PlannedEntry[],
  results: Map<PlannedEntry, string>,
  outcomes: Map<PlannedEntry, RestoreOutcome>,
  ctx: {
    /** Scan mode: the full pre-restore tab order to rebuild. */
    baseOrder: string[] | undefined
    /** Every block in a tab, from the snapshot taken before planning. */
    blocksOf: (tabId: string) => string[]
  },
): Promise<void> {
  const config = loadConfig()
  const extraFlags = config.claude.flags.map(shellQuoteArg).join(' ')

  // Probe before any socket teardown; adapters without the notion report none.
  const capabilities = adapter.backendCapabilities ? await adapter.backendCapabilities() : []
  const spawnWaitsForPty = capabilities.includes(CAP_SPAWN_WAITS_FOR_PTY)

  // old tab id → the tab that replaced it, or null when it just went away.
  const replacements = new Map<string, string | null>()
  const finalTabId = new Map<PlannedEntry, string>()
  for (const p of plan) {
    if (p.tabId && p.action !== 'recreate' && p.action !== 'duplicate') finalTabId.set(p, p.tabId)
  }

  // -- attach: send the resume into tabs that still have a live shell --
  // Suspended attaches get the placeholder instead, and are verified from the
  // process table below rather than by waiting for a Claude to start.
  const asleep = plan.filter((p) => p.action === 'attach' && p.suspended)
  for (const p of asleep) {
    const color = colorForEntry(p, config)
    if (color !== undefined) await applyTabColor(adapter, p.tabId!, color)
    try {
      await installPlaceholderInShell(adapter, p.blockId!, p.tabId!, placeholderRecordOf(p))
      results.set(p, '… placeholder sent, not yet verified')
    } catch (err) {
      results.set(p, `✘ could not suspend: ${(err as Error).message}`)
      outcomes.set(p, 'failed')
    }
  }
  const attached = plan.filter((p) => p.action === 'attach' && !p.suspended)
  for (const p of attached) {
    // Colour these too, not just the recreated ones. Whether a tab is attached
    // or recreated turns on whether its shell happens to be alive, which after
    // a terminal restart comes down to which tabs got focused first — so
    // colouring only the recreate path makes a restored fleet come back
    // half-coloured, in an order the user has no reason to predict.
    const color = colorForEntry(p, config)
    if (color !== undefined) await applyTabColor(adapter, p.tabId!, color)
    await adapter.sendInput(p.blockId!, buildResumeCommand(p, extraFlags) + '\r')
    await sleep(500)
  }

  // -- close the tabs we're replacing or dropping --
  for (const p of plan) {
    if (!p.closeTabId) continue
    for (const b of ctx.blocksOf(p.closeTabId)) adapter.deleteBlock(b)
    replacements.set(p.closeTabId, null)
  }

  // -- verify the attaches actually started Claude --
  if (attached.length) {
    consola.info('Waiting for sessions to start…')
    await sleep(ATTACH_SETTLE_MS)
    const launches = new LaunchTracker(adapter)
    await pollUntilSettled(attached, (p, final) => {
      // The process's own argv is the strongest answer — once it has stayed up
      // (see LAUNCH_SUSTAIN_MS). It needs no readable screen and no title on disk.
      if (p.sessionId) {
        const g = launches.judge(p, p.blockId, final)
        if (g.state === 'failed') return { outcome: 'failed', note: g.note }
        if (g.state === 'ok') return { outcome: 'restored', note: `✔ running ${shortId(p.sessionId)} (its process stayed up)` }
        // A screen reading "idle" is not enough while the process is unproven:
        // it can be the frame the exiting Claude left behind.
        if (g.state === 'wait') return null
      }
      const status = adapter.detectSessionStatus(p.blockId!)
      if (status === 'active' || status === 'idle') return { outcome: 'restored', note: '✔ running' }
      if (!final) return null
      if (status === 'unreadable') {
        // Readability is not liveness (see session-status.ts) — an empty
        // capture is a statement about the capture. Neither pass nor fail.
        return { outcome: 'unverified', note: '? no output captured — check it yourself' }
      }
      return { outcome: 'failed', note: `✘ no Claude started within ${VERIFY_DEADLINE_MS / 1000}s` }
    }, results, outcomes)
  }

  adapter.closeSocket()

  // -- spawn: recreated empty tabs and brand-new ones, in plan order --
  const toSpawn = plan.filter((p) => p.action === 'recreate' || p.action === 'spawn')
  if (toSpawn.length) {
    const recreates = toSpawn.filter((p) => p.action === 'recreate').length
    if (recreates) consola.info(`Recreating ${recreates} empty tab(s)…`)

    const spawnOne = async (p: PlannedEntry) => {
      if (p.suspended) {
        try {
          const newTabId = await openPlaceholderTab(adapter, placeholderRecordOf(p), { color: colorForEntry(p, config) })
          finalTabId.set(p, newTabId)
          if (p.closeTabId) replacements.set(p.closeTabId, newTabId)
          results.set(p, `… ${p.action === 'recreate' ? 'recreated' : 'spawned'} suspended [${newTabId.slice(0, 8)}], not yet verified`)
          outcomes.set(p, 'unverified')
        } catch (err) {
          results.set(p, `✘ ${p.action} (suspended) failed: ${(err as Error).message}`)
          outcomes.set(p, 'failed')
        }
        return
      }
      try {
        const claudeCmd = p.sessionId
          ? `claude --resume ${p.sessionId} --name ${JSON.stringify(p.entry.name)}${permissionModeFlag(p)}`
          // A fresh Claude still honours the captured mode: the manifest asked
          // for this tab, and the mode is part of what it asked for.
          : `claude${permissionModeFlag(p)}`
        const { env, model } = launchEnvFor(p.backend, p.configDir)
        const newTabId = await openSession({
          tabName: p.entry.name,
          dir: p.dir!,
          claudeCmd,
          envVars: env,
          modelOverride: model,
          color: colorForEntry(p, config),
          // Spawned tabs append; the whole bar is reordered below, so don't
          // insert after-active here.
          tailDelayMs: 500,
        })
        finalTabId.set(p, newTabId)
        if (p.closeTabId) replacements.set(p.closeTabId, newTabId)
        const verb = p.action === 'recreate' ? 'recreated' : 'spawned'
        // Provisional: the spawn call returning is not the tab working, which
        // is the whole reason for the verification pass below.
        results.set(p, `… ${verb} [${newTabId.slice(0, 8)}] (${shortId(p.sessionId)}), not yet verified`)
        outcomes.set(p, 'unverified')
      } catch (err) {
        results.set(p, `✘ ${p.action} failed: ${(err as Error).message}`)
        outcomes.set(p, 'failed')
      }
    }

    if (spawnWaitsForPty) {
      // The backend serialises creates and doesn't answer until each tab's
      // process is running, so firing them all at once is safe and much faster.
      await Promise.all(toSpawn.map(spawnOne))
    } else {
      // Create one at a time. On the direct-spawn path a new tab needs to stay
      // active long enough to attach its frontend and fork its PTY before the
      // next one steals activation (see SPAWN_SETTLE_MS). The osascript path
      // must be serial regardless — concurrent Cmd+T keystrokes would land in
      // the wrong tab — and self-paces via waitForNewBlock, so it needs no gap.
      const usesDirectSpawn = typeof adapter.openTabDirect === 'function'
      for (const p of toSpawn) {
        await spawnOne(p)
        if (usesDirectSpawn) await sleep(SPAWN_SETTLE_MS)
      }
    }
  }

  // -- verify what we just spawned, before claiming any of it worked --
  const awake = toSpawn.filter((p) => !p.suspended)
  if (awake.length) {
    await verifySpawns(
      adapter,
      awake.filter((p) => finalTabId.has(p)).map((p) => ({ p, tabId: finalTabId.get(p)! })),
      results,
      outcomes,
    )
  }
  await verifyPlaceholders(
    [...asleep, ...toSpawn.filter((p) => p.suspended)].filter((p) => outcomes.get(p) !== 'failed'),
    results,
    outcomes,
  )

  // -- rebuild the tab bar --
  // Best-effort: adapters without reorderTabs keep the append order, and
  // reorderTabs leaves unlisted tabs in their relative slot, sorted after.
  if (typeof adapter.reorderTabs === 'function') {
    const desiredOrder = buildDesiredOrder(
      plan.map((p) => finalTabId.get(p)),
      replacements,
      ctx.baseOrder,
    )
    if (desiredOrder.length) {
      try {
        await adapter.reorderTabs(desiredOrder)
      } catch (err) {
        consola.warn(`Could not restore tab order: ${(err as Error).message}`)
      }
    }
  }
}

/**
 * Re-read the terminal after spawning and decide what actually came up.
 *
 * This is the fix for a restore that reported "78 spawned, 0 failed" with one
 * tab missing and one stripped of its context. Nothing here trusts the spawn
 * call: the tab list is fetched again, the process is looked for, and the
 * session is resolved from disk — with the title-index cache dropped first,
 * because the cache was built while planning and would happily confirm the
 * pre-restore world.
 *
 * One fleet-wide settle, then one round of reads. A per-tab wait would turn a
 * 78-tab restore's verification into minutes.
 */
async function verifySpawns(
  adapter: TerminalAdapter,
  spawned: Array<{ p: PlannedEntry; tabId: string }>,
  results: Map<PlannedEntry, string>,
  outcomes: Map<PlannedEntry, RestoreOutcome>,
): Promise<void> {
  if (!spawned.length) return

  consola.info(`Verifying ${spawned.length} spawned tab(s)…`)
  await sleep(VERIFY_SETTLE_MS)

  const tabOf = new Map(spawned.map(({ p, tabId }) => [p, tabId]))
  const launches = new LaunchTracker(adapter)
  // Re-read the terminal once per round, not once per tab.
  let snapshot: { round: number; tabsById: Map<string, Block[]> | null } = { round: -1, tabsById: null }
  let round = 0

  await pollUntilSettled(spawned.map(({ p }) => p), (p, final) => {
    if (snapshot.round !== round) {
      snapshot = { round, tabsById: null }
      try {
        snapshot.tabsById = adapter.blocksList().reduce((m, b) => {
          const arr = m.get(b.tabid) ?? []
          arr.push(b)
          return m.set(b.tabid, arr)
        }, new Map<string, Block[]>())
      } catch (err) {
        consola.warn(`Could not re-read the tab list to verify the restore: ${(err as Error).message}`)
      }
    }
    const tabsById = snapshot.tabsById
    // Losing the terminal tells us nothing about the tabs, so they stay
    // `unverified` — reporting them as failed would be as wrong as reporting
    // them as restored.
    if (!tabsById) return final ? { outcome: 'unverified', note: '? could not re-read the tab list' } : null

    const blocks = tabsById.get(tabOf.get(p)!) ?? []
    const term = blocks.find((b) => b.view === 'term')

    let resolvedSessionId: string | undefined
    if (p.dir) {
      try {
        resolvedSessionId = resolveTabSession(p.dir, p.entry.name)?.id
      } catch {
        // An unreadable projects dir leaves the session unconfirmed, which
        // judgeSpawn already treats as its own answer.
      }
    }

    const launch = p.sessionId ? launches.judge(p, term?.blockid, final) : ({ state: 'unknown' } as LaunchJudgement)
    if (launch.state === 'failed') return { outcome: 'failed', note: `${launch.note} [${tabOf.get(p)!.slice(0, 8)}]` }

    const verdict = judgeSpawn({
      tabPresent: blocks.length > 0,
      hasTermBlock: !!term,
      hasProcess: processOf(term, tabsById),
      requestedSessionId: p.sessionId,
      resolvedSessionId,
      launchedLive: launch.state === 'ok' ? true : undefined,
    })
    // A transcript on disk says the session exists, not that this tab is
    // running it. While the process is unproven, "restored" has to wait.
    if (verdict.outcome === 'restored' && launch.state === 'wait') return null
    // Anything short of confirmed is re-checked until the deadline. A tab that
    // has not attached its PTY yet — which under load can take longer than the
    // plugin's own 20s wait — reads exactly like one that never will, and a
    // false "failed" on a fleet command invites a second restore pass over a
    // healthy tab. Only the deadline turns silence into a verdict.
    if (verdict.outcome !== 'restored' && !final) return null
    return { outcome: verdict.outcome, note: `${verdict.note} [${tabOf.get(p)!.slice(0, 8)}]` }
  }, results, outcomes, () => { round++ ; resetTitleIndexCache() })
}

/** The registry record a suspended restore entry becomes. */
function placeholderRecordOf(p: PlannedEntry) {
  return {
    sessionId: p.sessionId!,
    name: p.entry.name,
    dir: p.dir!,
    backend: p.backend,
    configDir: p.configDir,
    permissionMode: p.permissionMode,
  }
}

/**
 * Confirm each suspended entry has a placeholder waiting on its session.
 *
 * The process table is the whole check: a placeholder names its session in its
 * own argv, so nothing here depends on a tab's screen being readable — which,
 * for a fleet of freshly spawned background tabs, it mostly isn't. Where there
 * is no process table, the entries stay `unverified`, which is the truth.
 */
async function verifyPlaceholders(
  entries: PlannedEntry[],
  results: Map<PlannedEntry, string>,
  outcomes: Map<PlannedEntry, RestoreOutcome>,
): Promise<void> {
  if (!entries.length) return
  consola.info(`Verifying ${entries.length} suspended tab(s)…`)
  const deadline = Date.now() + 20_000
  let pending = entries
  while (pending.length) {
    const rows = readProcessTable()
    if (!rows) {
      for (const p of pending) results.set(p, '? suspended — no process table to confirm the placeholder')
      return
    }
    const waiting = placeholderSessions(rows)
    const final = Date.now() >= deadline
    pending = pending.filter((p) => {
      const ph = waiting.get(p.sessionId!.toLowerCase())
      if (ph && !ph.woken) {
        results.set(p, `⏸ suspended ${shortId(p.sessionId)} (placeholder pid ${ph.pid})`)
        outcomes.set(p, 'restored')
        return false
      }
      if (final) {
        results.set(p, `✘ no placeholder for ${shortId(p.sessionId)} appeared within 20s`)
        outcomes.set(p, 'failed')
        return false
      }
      return true
    })
    if (pending.length) await sleep(1000)
  }
}

/**
 * Whether a tab has a running process, from the best evidence the backend has.
 * `stable-pid` backends report the tab's own shell, which is alive or not; an
 * older plugin reports a spawn-time pid whose mere presence is the only signal.
 */
function processOf(term: Block | undefined, tabsById: Map<string, Block[]>): boolean | undefined {
  if (term?.shellPid !== undefined) return pidAlive(term.shellPid)
  const reportsPids = [...tabsById.values()].some((blocks) => blocks.some((b) => typeof b.pid === 'number'))
  return reportsPids ? typeof term?.pid === 'number' : undefined
}

/**
 * Is some live Claude process launched on this session id?
 *
 * The table is cached for a second: one verification round asks this of every
 * entry, and a 60-tab round should cost one `ps`, not sixty.
 */
let launchedCache: { at: number; ids: Map<string, number[]> | null } | undefined
function sessionLaunched(sessionId: string): boolean | undefined {
  if (!launchedCache || Date.now() - launchedCache.at > 1000) {
    const rows = readProcessTable()
    launchedCache = { at: Date.now(), ids: rows ? liveSessionPids(rows) : null }
  }
  return launchedCache.ids ? launchedCache.ids.has(sessionId) : undefined
}

/** Carries {@link LaunchObservation} state across rounds, one entry at a time. */
class LaunchTracker {
  private seen = new Map<PlannedEntry, { firstSeenAt?: number; everSeen: boolean }>()
  constructor(private adapter: TerminalAdapter) {}

  judge(p: PlannedEntry, blockId: string | undefined, final: boolean): LaunchJudgement {
    const now = Date.now()
    const live = sessionLaunched(p.sessionId!)
    const prev = this.seen.get(p) ?? { everSeen: false }
    const next = live
      ? { firstSeenAt: prev.firstSeenAt ?? now, everSeen: true }
      : { firstSeenAt: undefined, everSeen: prev.everSeen }
    this.seen.set(p, next)
    let screen: string | undefined
    if (live === false && blockId) {
      try { screen = this.adapter.scrollback(blockId, 15) } catch { /* explanation only */ }
    }
    return judgeLaunch({ live, ...next, now, final, screen }, p.sessionId!)
  }
}

/**
 * Re-check entries until each has a verdict or the deadline passes.
 *
 * `check` returns null for "not yet". On the last round it is called with
 * `final = true` and must decide.
 */
async function pollUntilSettled(
  entries: PlannedEntry[],
  check: (p: PlannedEntry, final: boolean) => SpawnVerdict | null,
  results: Map<PlannedEntry, string>,
  outcomes: Map<PlannedEntry, RestoreOutcome>,
  beforeRound: () => void = resetTitleIndexCache,
): Promise<void> {
  const deadline = Date.now() + VERIFY_DEADLINE_MS
  let pending = entries.filter((p) => outcomes.get(p) !== 'failed')
  while (pending.length) {
    const final = Date.now() >= deadline
    beforeRound()
    const still: PlannedEntry[] = []
    for (const p of pending) {
      const v = check(p, final)
      if (!v) { still.push(p); continue }
      results.set(p, v.note)
      outcomes.set(p, v.outcome)
    }
    pending = still
    if (pending.length) await sleep(Math.min(VERIFY_POLL_MS, Math.max(0, deadline - Date.now())))
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * The `claude --resume` line typed into a tab that still has a live shell.
 *
 * A session from a non-default Claude config dir needs that dir — and its
 * backend's base URL and model — on the command line, exactly as `resume -b`
 * would set them. Without it the id resolves to nothing and Claude opens a
 * fresh conversation in the tab, which looks like a successful restore.
 */
export function buildResumeCommand(p: PlannedEntry, extraFlags: string): string {
  const { env, model } = launchEnvFor(p.backend, p.configDir)
  const envPrefix = env ? shellQuoteEnv(env) : ''
  const modelPart = model ? ` --model ${JSON.stringify(model)}` : ''
  return `cd ${JSON.stringify(p.dir)} && ${envPrefix}claude${extraFlags ? ' ' + extraFlags : ''} --resume ${p.sessionId} --name ${JSON.stringify(p.entry.name)}${modelPart}${permissionModeFlag(p)}`
}

/**
 * The per-tab `--permission-mode`, which overrides whatever the global
 * `claude.flags` would otherwise settle on.
 *
 * Appended last so it wins over the configured flags. It composes with
 * `--allow-dangerously-skip-permissions` rather than conflicting with it —
 * that flag only makes bypass *available*, it doesn't select a mode — so a tab
 * captured in plan mode comes back in plan mode even under the usual config.
 */
export function permissionModeFlag(p: PlannedEntry): string {
  return p.permissionMode ? ` --permission-mode ${p.permissionMode}` : ''
}

/**
 * The colour a restored tab should come back with.
 *
 * A recorded colour wins — that's the tab as it actually was, whether captured
 * from a live tab in scan mode or round-tripped through a manifest. `null` is a
 * real answer there (deliberately uncoloured) and is honoured.
 *
 * Nothing recorded falls back to what the config implies for this entry's
 * backend: `[backends.<name>] color`, else `[defaults] color`. That's what makes
 * a rule like "the enterprise account's tabs are blue" hold after a reboot even
 * for manifests written before colours existed — the backend is already inferred
 * from the config dir the session was found in, so the colour follows it.
 */
export function colorForEntry(
  p: PlannedEntry,
  config: Config,
  // Injectable so the fallback chain is testable without a real config file on
  // disk; production callers take the default.
  backendColorOf: (name: string) => string | undefined = (name) => resolveBackend(name)?.color,
): string | null | undefined {
  if (p.color !== undefined) return p.color
  const backendColor = p.backend ? backendColorOf(p.backend) : undefined
  try {
    return resolveColorPreference(undefined, backendColor, config.defaults.color)
  } catch {
    // A bad colour in config must not take a 60-tab restore down with it.
    return undefined
  }
}

/** `KEY="value" ` prefix for a shell command, matching how `resume` builds it. */
function shellQuoteEnv(env: Record<string, string>): string {
  const entries = Object.entries(env)
  if (!entries.length) return ''
  return entries.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') + ' '
}
