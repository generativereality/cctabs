import { resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByNameGlobally, expandSessionId, resolveTabSession } from '../core/session.js'
import { parseManifest } from '../core/manifest.js'
import {
  planRestore,
  buildDesiredOrder,
  type PlanDeps,
  type PlannedEntry,
  type RestoreEntry,
  type ResolvedSession,
} from '../core/restore-plan.js'
import type { Block } from '../types/index.js'
import { shellQuoteArg } from '../core/shell.js'

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
  },
  async run(ctx) {
    const dryRun = !!(ctx.values.dry as boolean | undefined)
    const manifestPath = ctx.values.manifest as string | undefined
    const createMissing = (ctx.values['create-missing'] as boolean | undefined) ?? false

    if (manifestPath) {
      await runRestore({
        manifest: readManifestOrExit(manifestPath),
        scopedDir: null,
        createMissing,
        dryRun,
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

interface RestoreRequest {
  /** Manifest entries, or null to scan the window's own tabs. */
  manifest: RestoreEntry[] | null
  /** Scan mode: restrict session lookups to this directory. */
  scopedDir: string | null
  createMissing: boolean
  dryRun: boolean
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
async function runRestore(req: RestoreRequest): Promise<void> {
  const { dryRun } = req
  const adapter = requireAdapter()
  const { tabsById, tabNames, workspaces } = await adapter.getAllData()
  const currentTab = adapter.currentTabId()

  // Manifest mode restores into the current workspace. The scan restores what
  // it can see, which on Wave spans every open workspace.
  let scopeTabIds: Set<string>
  let entries: RestoreEntry[]
  let baseOrder: string[] | undefined

  if (req.manifest) {
    const currentWs = adapter.currentWorkspaceId()
    const currentWsData = workspaces.find((w) => w.workspacedata.oid === currentWs)
    scopeTabIds = currentWsData
      ? new Set(currentWsData.workspacedata.tabids)
      : new Set<string>(tabsById.keys())
    entries = req.manifest
  } else {
    // Scan: one entry per terminal tab, in bar order, each bound to its tab.
    // Live tabs are included so they're reported and so they claim their name
    // against a same-named dead tab elsewhere in the bar.
    scopeTabIds = new Set<string>()
    entries = []
    baseOrder = []
    for (const wsp of workspaces) {
      for (const tabId of wsp.workspacedata.tabids) {
        baseOrder.push(tabId)
        scopeTabIds.add(tabId)
        if (tabId === currentTab) continue
        if (!(tabsById.get(tabId) ?? []).some((b) => b.view === 'term')) continue
        entries.push({
          name: tabNames.get(tabId) ?? tabId.slice(0, 8),
          dir: req.scopedDir ?? undefined,
          tabId,
        })
      }
    }
    if (!entries.length) {
      consola.info('No tabs to restore.')
      adapter.closeSocket()
      return
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
    }),
  )

  const running = plan.filter((p) => p.action === 'already-running')
  if (running.length) {
    consola.info(`Already running: ${running.map((p) => p.entry.name).join(', ')}`)
  }

  const actionable = plan.filter(
    (p) => p.action === 'attach' || p.action === 'recreate' || p.action === 'spawn',
  )
  consola.info(`${actionable.length} tab(s) to restore${dryRun ? ' (dry run)' : ''}:`)
  for (const p of plan) {
    // Already-running tabs are covered by the one-line list above; repeating
    // them here buries the entries that actually need a decision.
    if (p.action === 'already-running') continue
    consola.log(`  ${p.entry.name} ${describeDecision(p, dryRun)}`)
  }

  const results = new Map<PlannedEntry, string>(plan.map((p) => [p, summarizeDecision(p, dryRun)]))

  if (!dryRun) {
    await executePlan(adapter, plan, results, {
      baseOrder,
      blocksOf: (tabId) => (tabsById.get(tabId) ?? []).map((b) => b.blockid),
    })
  }

  adapter.closeSocket()

  console.log('\nRestore summary:')
  for (const p of plan) {
    console.log(`  ${p.entry.name}: ${results.get(p)}`)
  }
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
  },
): PlanDeps {
  return {
    currentTabId: opts.currentTabId,
    scopeTabIds: opts.scopeTabIds,
    // Exact-name only: a longer-named live tab (`gapminder-login`) must never
    // be taken as proof that `gapminder`'s tab already exists.
    matchTabs: (name) => adapter.resolveTab(name, opts.tabsById, opts.tabNames, { exact: true }),
    termBlockOf: (tabId) => (opts.tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.blockid,
    statusOf: (blockId) => adapter.detectSessionStatus(blockId),
    confirmEmpty: (blockId) => adapter.confirmScrollbackEmpty(blockId),
    resolveSession: (entry) => resolveEntrySession(entry),
    createMissing: opts.createMissing,
  }
}

/**
 * Find the session an entry should resume.
 *
 * Three shapes, in descending order of confidence:
 *   - an explicit id from a manifest (expanded from a prefix if needed);
 *   - a directory, which resolves worktree-aware and newest-first, so a
 *     `--worktree` tab picks its worktree session over a stale repo-root one;
 *   - name only, which searches every project and takes the newest match.
 */
function resolveEntrySession(entry: RestoreEntry): ResolvedSession | null {
  if (entry.sessionId) {
    const expanded =
      expandSessionId(entry.sessionId, entry.dir) ?? expandSessionId(entry.sessionId)
    return { id: expanded ?? entry.sessionId, dir: entry.dir ?? process.cwd() }
  }

  if (entry.dir) {
    const hit = resolveTabSession(entry.dir, entry.name)
    return hit ? { id: hit.id, dir: hit.dir } : null
  }

  const sessions = findSessionsByNameGlobally(entry.name)
  if (!sessions.length) return null
  if (sessions.length > 1) {
    consola.log(`  ${entry.name} — multiple sessions across projects, picking newest (${sessions[0].dir})`)
  }
  return { id: sessions[0].id, dir: sessions[0].dir }
}

export const shortId = (id?: string) => (id ? `${id.slice(0, 8)}…` : 'fresh')

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
    case 'attach':
      return `→ ${dry ? 'would resume' : 'resuming'} ${shortId(p.sessionId)} in existing tab`
    case 'recreate':
      return `→ ${dry ? 'would recreate' : 'recreating'} dead tab with ${shortId(p.sessionId)} in ${p.dir}`
    case 'duplicate':
      return p.closeTabId
        ? `— duplicate dead tab, ${dry ? 'would close' : 'closing'} (already restoring one)`
        : '— duplicate entry, skipping (already restoring one)'
    case 'spawn':
      return `→ ${dry ? 'would spawn' : 'spawning'} new tab in ${p.dir} (${shortId(p.sessionId)})`
    case 'missing':
      return '— no existing tab; pass --create-missing to spawn one'
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
    case 'attach':
      return dry ? `dry run: attach ${shortId(p.sessionId)}` : 'sent'
    case 'recreate':
      return dry ? `dry run: recreate (${shortId(p.sessionId)})` : 'queued for recreate'
    case 'duplicate':
      return p.closeTabId
        ? dry ? 'dry run: close duplicate dead tab' : 'duplicate dead tab — closed'
        : 'duplicate entry — skipped'
    case 'spawn':
      return dry ? `dry run: spawn (${shortId(p.sessionId)})` : 'queued for spawn'
    case 'missing':
      return 'missing (skipped, no --create-missing)'
  }
}

/** Carry out a plan. Only ever called for a real (non-dry) run. */
async function executePlan(
  adapter: TerminalAdapter,
  plan: PlannedEntry[],
  results: Map<PlannedEntry, string>,
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
  const attached = plan.filter((p) => p.action === 'attach')
  for (const p of attached) {
    const cmd = `cd ${JSON.stringify(p.dir)} && claude${extraFlags ? ' ' + extraFlags : ''} --resume ${p.sessionId} --name ${JSON.stringify(p.entry.name)}\r`
    await adapter.sendInput(p.blockId!, cmd)
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
    await sleep(10_000)
    for (const p of attached) {
      const status = adapter.detectSessionStatus(p.blockId!)
      if (status === 'active' || status === 'idle') results.set(p, '✔ running')
      else if (status === 'unknown') results.set(p, '? scrollback unavailable')
      else results.set(p, '✘ may not have started')
    }
  }

  adapter.closeSocket()

  // -- spawn: recreated dead tabs and brand-new ones, in plan order --
  const toSpawn = plan.filter((p) => p.action === 'recreate' || p.action === 'spawn')
  if (toSpawn.length) {
    const recreates = toSpawn.filter((p) => p.action === 'recreate').length
    if (recreates) consola.info(`Recreating ${recreates} dead tab(s)…`)

    const spawnOne = async (p: PlannedEntry) => {
      try {
        const claudeCmd = p.sessionId
          ? `claude --resume ${p.sessionId} --name ${JSON.stringify(p.entry.name)}`
          : 'claude'
        const newTabId = await openSession({
          tabName: p.entry.name,
          dir: p.dir!,
          claudeCmd,
          // Spawned tabs append; the whole bar is reordered below, so don't
          // insert after-active here.
          tailDelayMs: 500,
        })
        finalTabId.set(p, newTabId)
        if (p.closeTabId) replacements.set(p.closeTabId, newTabId)
        const verb = p.action === 'recreate' ? 'recreated' : 'spawned'
        results.set(p, `✔ ${verb} [${newTabId.slice(0, 8)}] (${shortId(p.sessionId)})`)
      } catch (err) {
        results.set(p, `✘ ${p.action} failed: ${(err as Error).message}`)
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

  // -- rebuild the tab bar --
  // Best-effort: adapters without reorderTabs (Wave) keep the append order, and
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
