import { resolve } from 'path'
import { homedir } from 'os'
import { readFileSync, existsSync } from 'fs'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireAdapter } from '../core/adapter.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByName, findSessionsByNameGlobally, expandSessionId } from '../core/session.js'

interface ManifestEntry {
  name: string
  dir: string
  session_id?: string
}

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

function parseManifest(raw: string): ManifestEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`Manifest is not valid JSON: ${(err as Error).message}`)
  }

  // Accept three shapes:
  //   1. Plain array of entries:                [{name, dir, session_id?}, ...]
  //   2. Object with sessions array:            {sessions: [...]}
  //   3. `cctabs sessions --json` output:       {workspaces: [{sessions: [...]}, ...]}
  const collected: unknown[] = []
  if (Array.isArray(parsed)) {
    collected.push(...parsed)
  } else if (parsed && typeof parsed === 'object') {
    const p = parsed as Record<string, unknown>
    if (Array.isArray(p.sessions)) {
      collected.push(...p.sessions)
    }
    if (Array.isArray(p.workspaces)) {
      for (const ws of p.workspaces) {
        if (ws && typeof ws === 'object' && Array.isArray((ws as Record<string, unknown>).sessions)) {
          collected.push(...((ws as Record<string, unknown>).sessions as unknown[]))
        }
      }
    }
  }

  const entries: ManifestEntry[] = []
  for (const item of collected) {
    if (!item || typeof item !== 'object') continue
    const it = item as Record<string, unknown>
    const name = typeof it.name === 'string' ? it.name : null
    const dir = typeof it.dir === 'string' ? it.dir : typeof it.cwd === 'string' ? it.cwd : null
    if (!name || !dir) continue
    const sid = typeof it.session_id === 'string' ? it.session_id : undefined
    entries.push({ name, dir: resolve(dir.replace(/^~/, homedir())), session_id: sid })
  }
  return entries
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
    const dryRun = ctx.values.dry as boolean | undefined
    const manifestPath = ctx.values.manifest as string | undefined
    const createMissing = (ctx.values['create-missing'] as boolean | undefined) ?? false

    if (manifestPath) {
      await runManifestMode(manifestPath, createMissing, !!dryRun)
      return
    }

    if (createMissing) {
      consola.warn('--create-missing has no effect without --manifest; ignoring.')
    }

    await runLegacyMode(ctx.positionals[1], !!dryRun)
  },
})

async function runManifestMode(manifestPath: string, createMissing: boolean, dryRun: boolean): Promise<void> {
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

  let entries: ManifestEntry[]
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

  const adapter = requireAdapter()
  const { tabsById, tabNames, workspaces } = await adapter.getAllData()
  const currentWs = adapter.currentWorkspaceId()
  const currentTab = adapter.currentTabId()

  // Scope to current workspace
  const currentWsData = workspaces.find((w) => w.workspacedata.oid === currentWs)
  const wsTabIds = currentWsData ? new Set(currentWsData.workspacedata.tabids) : new Set<string>(tabsById.keys())

  const results: Array<{ name: string; result: string }> = []
  const toSpawn: Array<ManifestEntry> = []
  const config = loadConfig()
  const extraFlags = config.claude.flags.join(' ')

  for (const entry of entries) {
    // Resolve session ID (expand prefix or validate). Falls back to the entry's value.
    let resolvedSessionId: string | undefined = entry.session_id
    if (entry.session_id) {
      const expanded = expandSessionId(entry.session_id, entry.dir) ?? expandSessionId(entry.session_id)
      if (expanded) resolvedSessionId = expanded
    } else {
      // Try to infer from name+dir
      const sessions = findSessionsByName(entry.dir, entry.name)
      if (sessions.length === 1) {
        resolvedSessionId = sessions[0].id
      } else if (sessions.length > 1) {
        resolvedSessionId = sessions[0].id // newest
      }
    }

    const matchingTabs = adapter.resolveTab(entry.name, tabsById, tabNames).filter((tid) => wsTabIds.has(tid) && tid !== currentTab)

    if (matchingTabs.length > 1) {
      consola.log(`  ${entry.name} — multiple matching tabs, skipping`)
      results.push({ name: entry.name, result: 'ambiguous (multiple tabs)' })
      continue
    }

    if (matchingTabs.length === 1) {
      // Existing tab — attach (use existing dead-tab logic)
      const tabId = matchingTabs[0]
      const termBlock = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')
      if (!termBlock) {
        results.push({ name: entry.name, result: 'no terminal block in tab' })
        continue
      }
      const status = adapter.detectSessionStatus(termBlock.blockid)
      if (status === 'active' || status === 'idle') {
        consola.log(`  ${entry.name} — already running, skipping`)
        results.push({ name: entry.name, result: 'already running' })
        continue
      }
      if (!resolvedSessionId) {
        consola.log(`  ${entry.name} — no session ID and none found in ${entry.dir}, skipping`)
        results.push({ name: entry.name, result: 'no matching session' })
        continue
      }
      if (dryRun) {
        consola.log(`  ${entry.name} → would resume ${resolvedSessionId.slice(0, 8)}… in existing tab`)
        results.push({ name: entry.name, result: `dry run: attach ${resolvedSessionId.slice(0, 8)}…` })
        continue
      }
      consola.log(`  ${entry.name} → resuming ${resolvedSessionId.slice(0, 8)}… in existing tab`)
      const cmd = `cd ${JSON.stringify(entry.dir)} && claude${extraFlags ? ' ' + extraFlags : ''} --resume ${resolvedSessionId} --name ${JSON.stringify(entry.name)}\r`
      await adapter.sendInput(termBlock.blockid, cmd)
      await new Promise((r) => setTimeout(r, 500))
      results.push({ name: entry.name, result: 'sent' })
      continue
    }

    // No matching tab
    if (!createMissing) {
      consola.log(`  ${entry.name} — no existing tab; pass --create-missing to spawn one`)
      results.push({ name: entry.name, result: 'missing (skipped, no --create-missing)' })
      continue
    }
    if (dryRun) {
      const sid = resolvedSessionId ? `${resolvedSessionId.slice(0, 8)}…` : 'fresh'
      consola.log(`  ${entry.name} → would spawn new tab in ${entry.dir} (${sid})`)
      results.push({ name: entry.name, result: `dry run: spawn (${sid})` })
      continue
    }
    toSpawn.push({ ...entry, session_id: resolvedSessionId })
  }

  // Verify any "sent" entries after a brief delay (matches existing restore UX)
  if (!dryRun) {
    const sent = results.filter((r) => r.result === 'sent')
    if (sent.length) {
      consola.info('Waiting for sessions to start…')
      await new Promise((r) => setTimeout(r, 10_000))
      for (const r of sent) {
        const tabIds = adapter.resolveTab(r.name, tabsById, tabNames).filter((tid) => wsTabIds.has(tid) && tid !== currentTab)
        const tabId = tabIds[0]
        const termBlock = tabId ? (tabsById.get(tabId) ?? []).find((b) => b.view === 'term') : undefined
        if (!termBlock) { r.result = '? tab disappeared'; continue }
        const status = adapter.detectSessionStatus(termBlock.blockid)
        if (status === 'active' || status === 'idle') r.result = '✔ running'
        else if (status === 'unknown') r.result = '? scrollback unavailable'
        else r.result = '✘ may not have started'
      }
    }
  }

  adapter.closeSocket()

  // Spawn new tabs. Adapters with openTabDirect (Tabby) return the new tab id
  // directly, so there is no block-diff race — spawn them all at once. The
  // osascript path (Wave) must stay serial.
  const spawnOne = async (entry: ManifestEntry) => {
    try {
      const claudeCmd = entry.session_id
        ? `claude --resume ${entry.session_id} --name ${JSON.stringify(entry.name)}`
        : 'claude'
      const newTabId = await openSession({
        tabName: entry.name,
        dir: entry.dir,
        claudeCmd,
        tailDelayMs: 500,
      })
      const sid = entry.session_id ? entry.session_id.slice(0, 8) + '…' : 'fresh'
      results.push({ name: entry.name, result: `✔ spawned [${newTabId.slice(0, 8)}] (${sid})` })
    } catch (err) {
      results.push({ name: entry.name, result: `✘ spawn failed: ${(err as Error).message}` })
    }
  }

  if (typeof adapter.openTabDirect === 'function') {
    await Promise.all(toSpawn.map(spawnOne))
  } else {
    for (const entry of toSpawn) await spawnOne(entry)
  }

  console.log('\nRestore summary:')
  for (const r of results) {
    console.log(`  ${r.name}: ${r.result}`)
  }
}

async function runLegacyMode(rawDir: string | undefined, dryRun: boolean): Promise<void> {
  const scopedDir = rawDir ? resolve(rawDir.replace(/^~/, homedir())) : null

  const adapter = requireAdapter()
  const { tabsById, workspaces, tabNames } = await adapter.getAllData()
  const currentTab = adapter.currentTabId()

  const tabs: Array<{
    tabId: string
    name: string
    blockId: string
    status: string
  }> = []

  for (const wsp of workspaces) {
    for (const tabId of wsp.workspacedata.tabids) {
      if (tabId === currentTab) continue
      const blocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
      if (!blocks.length) continue
      const name = tabNames.get(tabId) ?? tabId.slice(0, 8)
      const status = adapter.detectSessionStatus(blocks[0].blockid)
      tabs.push({ tabId, name, blockId: blocks[0].blockid, status })
    }
  }

  const toResume = tabs.filter((t) => t.status === 'terminal' || t.status === 'unknown')
  const alreadyActive = tabs.filter((t) => t.status === 'active' || t.status === 'idle')

  if (alreadyActive.length) {
    consola.info(`Already running: ${alreadyActive.map((t) => t.name).join(', ')}`)
  }

  if (!toResume.length) {
    consola.info('No terminal-state tabs to restore.')
    adapter.closeSocket()
    return
  }

  consola.info(`Found ${toResume.length} tab(s) to restore:`)

  const config = loadConfig()
  const extraFlags = config.claude.flags.join(' ')
  const results: Array<{ name: string; result: string }> = []

  const toRecreate: Array<{ name: string; sessionId: string; sessionDir: string; blockIds: string[]; tabId: string }> = []

  // Pass 1 (sync): resolve each tab's session. Defer the slow per-tab
  // confirmScrollbackEmpty / sendInput work so the empty-checks can be batched.
  interface Resolved { tab: typeof toResume[number]; sessionId: string; sessionDir: string }
  const resolved: Resolved[] = []

  for (const tab of toResume) {
    let sessionId: string | null = null
    let sessionDir: string | null = null

    if (scopedDir) {
      const sessions = findSessionsByName(scopedDir, tab.name)
      if (sessions.length === 0) {
        consola.log(`  ${tab.name} — no session named "${tab.name}" found in ${scopedDir}, skipping`)
        results.push({ name: tab.name, result: 'no matching session' })
        continue
      }
      if (sessions.length > 1) {
        consola.log(`  ${tab.name} — multiple sessions found, skipping (use cctabs resume --session to pick one)`)
        results.push({ name: tab.name, result: 'ambiguous (multiple sessions)' })
        continue
      }
      sessionId = sessions[0].id
      sessionDir = scopedDir
    } else {
      const sessions = findSessionsByNameGlobally(tab.name)
      if (sessions.length === 0) {
        consola.log(`  ${tab.name} — no session named "${tab.name}" found in any project, skipping`)
        results.push({ name: tab.name, result: 'no matching session' })
        continue
      }
      if (sessions.length > 1) {
        consola.log(`  ${tab.name} — multiple sessions found across projects, picking newest (${sessions[0].dir})`)
      }
      sessionId = sessions[0].id
      sessionDir = sessions[0].dir
    }

    if (dryRun) {
      const mode = tab.status === 'unknown' ? 'recreate' : 'send'
      consola.log(`  ${tab.name} → would ${mode} session ${sessionId.slice(0, 8)}… in ${sessionDir}`)
      results.push({ name: tab.name, result: `dry run: ${sessionId.slice(0, 8)}…` })
      continue
    }

    resolved.push({ tab, sessionId, sessionDir })
  }

  if (!dryRun) {
    // Pass 2 (parallel): confirm the 'unknown'-status tabs really are dead.
    // confirmScrollbackEmpty awaits sleeps between polls; running them
    // concurrently lets those sleeps overlap (~1s total instead of ~1s × N).
    const unknownTabs = resolved.filter((r) => r.tab.status === 'unknown')
    const emptyById = new Map<string, boolean>()
    await Promise.all(
      unknownTabs.map(async (r) => {
        emptyById.set(r.tab.tabId, await adapter.confirmScrollbackEmpty(r.tab.blockId))
      }),
    )

    // Pass 3: queue recreates for confirmed-dead tabs; send to the rest.
    for (const r of resolved) {
      const { tab, sessionId, sessionDir } = r
      if (tab.status === 'unknown' && emptyById.get(tab.tabId)) {
        const blockIds = (tabsById.get(tab.tabId) ?? []).map((b) => b.blockid)
        toRecreate.push({ name: tab.name, sessionId, sessionDir, blockIds, tabId: tab.tabId })
        results.push({ name: tab.name, result: 'queued for recreate' })
        continue
      }

      consola.log(`  ${tab.name} → resuming session ${sessionId.slice(0, 8)}… in ${sessionDir} (send)`)
      const cmd = `cd ${JSON.stringify(sessionDir)} && claude${extraFlags ? ' ' + extraFlags : ''} --resume ${sessionId} --name ${JSON.stringify(tab.name)}\r`
      await adapter.sendInput(tab.blockId, cmd)

      await new Promise((r) => setTimeout(r, 500))
      results.push({ name: tab.name, result: 'sent' })
    }
  }

  if (!dryRun) {
    const sent = results.filter((r) => r.result === 'sent')
    if (sent.length) {
      consola.info('Waiting for sessions to start…')
      await new Promise((r) => setTimeout(r, 10_000))

      for (const r of sent) {
        const tab = toResume.find((t) => t.name === r.name)!
        const status = adapter.detectSessionStatus(tab.blockId)
        if (status === 'active' || status === 'idle') {
          r.result = '✔ running'
        } else if (status === 'unknown') {
          r.result = '? scrollback unavailable'
        } else {
          r.result = '✘ may not have started'
        }
      }
    }
  }

  if (!dryRun && toRecreate.length) {
    for (const t of toRecreate) {
      for (const bid of t.blockIds) adapter.deleteBlock(bid)
    }
    adapter.closeSocket()

    consola.info(`Recreating ${toRecreate.length} dead tab(s)…`)

    const recreateOne = async (t: typeof toRecreate[number]) => {
      try {
        const newTabId = await openSession({
          tabName: t.name,
          dir: t.sessionDir,
          claudeCmd: `claude --resume ${t.sessionId} --name ${JSON.stringify(t.name)}`,
          // waitForNewBlock already confirms each new block is visible before
          // returning, so the full 2s settle isn't needed between recreates.
          tailDelayMs: 500,
        })
        const r = results.find((x) => x.name === t.name)!
        r.result = `✔ recreated [${newTabId.slice(0, 8)}]`
      } catch (err) {
        const r = results.find((x) => x.name === t.name)!
        r.result = `✘ recreate failed: ${(err as Error).message}`
      }
    }

    // Adapters that return the new tab id directly (openTabDirect, e.g. Tabby)
    // have no block-diff to race, so recreate every tab at once. The osascript
    // path (Wave) must stay serial — concurrent Cmd+T keystrokes would land in
    // the wrong tab and waitForNewBlock could not disambiguate the new blocks.
    if (typeof adapter.openTabDirect === 'function') {
      await Promise.all(toRecreate.map(recreateOne))
    } else {
      for (const t of toRecreate) await recreateOne(t)
    }
  } else {
    adapter.closeSocket()
  }

  console.log('\nRestore summary:')
  for (const r of results) {
    console.log(`  ${r.name}: ${r.result}`)
  }
}
