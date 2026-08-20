import { resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireAdapter, type TerminalAdapter } from '../core/adapter.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByNameGlobally, locateSessionById, resolveTabSession } from '../core/session.js'
import { launchEnvFor, resolveBackend } from '../core/backends.js'
import type { ConfigDirScope } from '../core/config-dirs.js'
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
import { resolveColorPreference } from '../core/colors.js'

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
    entries = req.manifest
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
    /** Which Claude config dirs to search. Defaults to every one on the machine. */
    sessionScope?: ConfigDirScope
  },
): PlanDeps {
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
      if (!reportsPids) return undefined
      return (opts.tabsById.get(tabId) ?? []).some((b) => typeof b.pid === 'number')
    },
    // Exact-name only: a longer-named live tab (`gapminder-login`) must never
    // be taken as proof that `gapminder`'s tab already exists.
    matchTabs: (name) => adapter.resolveTab(name, opts.tabsById, opts.tabNames, { exact: true }),
    termBlockOf: (tabId) => (opts.tabsById.get(tabId) ?? []).find((b) => b.view === 'term')?.blockid,
    statusOf: (blockId) => adapter.detectSessionStatus(blockId),
    confirmEmpty: (blockId) => adapter.confirmScrollbackEmpty(blockId),
    resolveSession: (entry) => resolveEntrySession(entry, opts.sessionScope),
    createMissing: opts.createMissing,
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
      return `→ ${dry ? 'would resume' : 'resuming'} ${shortId(p.sessionId)} in existing tab${originNote(p)}${modeNote(p)}`
    case 'recreate':
      return `→ ${dry ? 'would recreate' : 'recreating'} empty tab (no process) with ${shortId(p.sessionId)} in ${p.dir}${originNote(p)}${modeNote(p)}`
    case 'duplicate':
      return p.closeTabId
        ? `— duplicate empty tab, ${dry ? 'would close' : 'closing'} (already restoring one)`
        : '— duplicate entry, skipping (already restoring one)'
    case 'spawn':
      return `→ ${dry ? 'would spawn' : 'spawning'} new tab in ${p.dir} (${shortId(p.sessionId)})${originNote(p)}${modeNote(p)}`
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
    await sleep(10_000)
    for (const p of attached) {
      const status = adapter.detectSessionStatus(p.blockId!)
      if (status === 'active' || status === 'idle') results.set(p, '✔ running')
      else if (status === 'unreadable') results.set(p, '? no output captured — check it yourself')
      else results.set(p, '✘ may not have started')
    }
  }

  adapter.closeSocket()

  // -- spawn: recreated empty tabs and brand-new ones, in plan order --
  const toSpawn = plan.filter((p) => p.action === 'recreate' || p.action === 'spawn')
  if (toSpawn.length) {
    const recreates = toSpawn.filter((p) => p.action === 'recreate').length
    if (recreates) consola.info(`Recreating ${recreates} empty tab(s)…`)

    const spawnOne = async (p: PlannedEntry) => {
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
