import { statSync } from 'fs'
import { homedir } from 'os'
import { consola } from 'consola'
import type { AllData, PermissionMode } from '../types/index.js'
import type { TerminalAdapter } from './adapter.js'
import { loadConfig } from './config.js'
import { launchEnvFor } from './backends.js'
import { liveSessionPids, matchTabsToClaude, readProcessTable, type ProcRow } from './claude-procs.js'
import { applyTabColor, supportsTabColor } from './colors.js'
import { clearStartupDialogs, confirmResumePicker } from './open-session.js'
import {
  autoModeDialogVisible,
  claudeInputReady,
  mcpApprovalDialogVisible,
  suspendMarkerShowing,
  trustDialogVisible,
} from './session-status.js'
import { resolveTabShell, shellQuoteArg, tabLaunchArgv } from './shell.js'
import {
  matchSuspendedTabs,
  placeholderBody,
  placeholderSessions,
  readRecords,
  recordPath,
  removeRecord,
  shellCanHostPlaceholder,
  wakeNonce,
  writeRecord,
  type PlaceholderSpec,
  type SuspendedMatch,
  type SuspendRecord,
} from './suspend.js'
import { pidAlive } from './tab-exit.js'
import { locateTranscriptFile } from './transcript.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const stripWs = (s: string) => s.replace(/\s+/g, '')

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/**
 * Which tabs are suspended right now, keyed by tab id.
 *
 * Also keeps the registry honest as a side effect, because every caller that
 * looks is also the one best placed to notice drift:
 *   - a record found by name or by process under a NEW tab id (Tabby
 *     restarted) is re-pointed at that tab, so the next lookup is exact;
 *   - a record whose session a live Claude is now running was woken by hand
 *     without the placeholder's own `rm` getting to it, and is dropped.
 * Records whose tab is simply absent are kept: that can be a closed window
 * rather than a closed tab, and deleting on absence would forget a fleet.
 */
export function suspendedTabsIn(
  adapter: TerminalAdapter,
  data: Pick<AllData, 'tabsById' | 'tabNames'>,
  procRows: ProcRow[] | null,
): Map<string, SuspendedMatch> {
  const records = readRecords()
  const tabs = [...data.tabsById.entries()].flatMap(([tabId, blocks]) => {
    const term = blocks.find((b) => b.view === 'term')
    if (!term) return []
    return [{
      tabId,
      name: data.tabNames.get(tabId) ?? tabId.slice(0, 8),
      cwd: term.meta?.['cmd:cwd'],
      shellPid: term.shellPid,
      shellAlive: term.shellPid !== undefined ? pidAlive(term.shellPid) : undefined,
      blockId: term.blockid,
    }]
  })
  const claudeByTab = procRows
    ? matchTabsToClaude(tabs.map((t) => ({ tabId: t.tabId, name: t.name, shellPid: t.shellPid })), procRows)
    : new Map()
  const placeholders = procRows ? placeholderSessions(procRows) : null
  const blockOf = new Map(tabs.map((t) => [t.tabId, t.blockId]))

  const matched = matchSuspendedTabs(
    tabs.map((t) => ({ ...t, claudeRunning: claudeByTab.has(t.tabId) })),
    records,
    placeholders,
    (tabId) => suspendMarkerShowing(adapter.scrollback(blockOf.get(tabId)!, 20)),
  )

  // -- heal the registry --
  for (const [tabId, m] of matched) {
    if (m.via === 'marker' || !m.record.sessionId) continue
    if (m.record.tabId !== tabId && m.record.suspendedAt) {
      try { writeRecord({ ...m.record, tabId }) } catch { /* best effort */ }
    }
  }
  if (procRows) {
    const live = liveSessionPids(procRows)
    for (const r of records) {
      const ph = placeholders?.get(r.sessionId.toLowerCase())
      if (live.has(r.sessionId.toLowerCase()) && (!ph || ph.woken)) removeRecord(r.sessionId)
    }
  }
  return matched
}

/** The one-line summary the placeholder shows: transcript size and directory. */
function placeholderDetail(sessionId: string, dir: string): string {
  const parts: string[] = []
  const located = locateTranscriptFile(sessionId)
  if (located) {
    try { parts.push(formatSize(statSync(located.file).size)) } catch { /* size is decoration */ }
  }
  parts.push(dir.replace(homedir(), '~'))
  return parts.join(' · ')
}

/** Build the placeholder for a record, from the current config. */
export function placeholderSpecFor(rec: SuspendRecord): PlaceholderSpec {
  const { env, model } = launchEnvFor(rec.backend, rec.configDir)
  return {
    sessionId: rec.sessionId,
    name: rec.name,
    dir: rec.dir,
    env,
    model,
    permissionMode: rec.permissionMode,
    extraFlags: loadConfig().claude.flags,
    detail: placeholderDetail(rec.sessionId, rec.dir),
    recordFile: recordPath(rec.sessionId),
  }
}

/** Refuse early, with a reason, on a shell that can't run the placeholder. */
export function placeholderShellOrThrow() {
  const shell = resolveTabShell()
  if (!shellCanHostPlaceholder(shell)) {
    throw new Error(
      `Suspended tabs need bash or zsh as the tab shell; this machine resolves to ${shell.command}. ` +
      'Set CCTABS_SHELL to a bash or zsh to use them.',
    )
  }
  return shell
}

/**
 * Open a new tab running the placeholder for `rec`, and register it.
 * Returns the new tab id.
 */
export async function openPlaceholderTab(
  adapter: TerminalAdapter,
  rec: Omit<SuspendRecord, 'suspendedAt' | 'tabId'>,
  opts: { afterActive?: boolean; color?: string | null } = {},
): Promise<string> {
  if (!adapter.openTabDirect) throw new Error('This terminal backend cannot open a tab with a command, which a placeholder needs.')
  const shell = placeholderShellOrThrow()
  const record: SuspendRecord = { ...rec, suspendedAt: new Date().toISOString() }
  // Written before the tab exists, so a placeholder woken the instant it
  // appears still has a record to delete.
  writeRecord(record)
  const color = opts.color !== undefined && (await supportsTabColor(adapter)) ? opts.color : undefined
  try {
    const { tabId } = await adapter.openTabDirect({
      cwd: rec.dir,
      title: rec.name,
      command: shell.command,
      args: tabLaunchArgv(shell, placeholderBody(placeholderSpecFor(record))),
      afterActive: opts.afterActive,
      color,
    })
    writeRecord({ ...record, tabId })
    return tabId
  } catch (err) {
    removeRecord(rec.sessionId)
    throw err
  }
}

/**
 * Replace the live shell in an existing tab with the placeholder, keeping the
 * tab (and its id, position and colour).
 *
 * Done with `exec`, so the tab's shell pid does not change and its argv becomes
 * the placeholder's — which is what lets `ps` identify it afterwards. The line
 * starts with a space so shells set to ignore space-prefixed commands keep it
 * out of history, and ctrl-u first clears anything half-typed.
 */
export async function installPlaceholderInShell(
  adapter: TerminalAdapter,
  blockId: string,
  tabId: string,
  rec: Omit<SuspendRecord, 'suspendedAt' | 'tabId'>,
): Promise<void> {
  const shell = placeholderShellOrThrow()
  const record: SuspendRecord = { ...rec, tabId, suspendedAt: new Date().toISOString() }
  writeRecord(record)
  const argv = [shell.command, ...tabLaunchArgv(shell, placeholderBody(placeholderSpecFor(record)))]
  await adapter.sendInput(blockId, '\x15')
  await sleep(100)
  await adapter.sendInput(blockId, ` exec ${argv.map(shellQuoteArg).join(' ')}`)
  await sleep(200)
  await adapter.sendInput(blockId, '\r')
}

/**
 * Wait until a placeholder is waiting for `sessionId`, from the process table.
 * `undefined` where there is no process table to ask.
 */
export async function waitForPlaceholder(sessionId: string, timeoutMs = 10_000): Promise<boolean | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = readProcessTable()
    if (!rows) return undefined
    const ph = placeholderSessions(rows).get(sessionId.toLowerCase())
    if (ph && !ph.woken) return true
    if (Date.now() >= deadline) return false
    await sleep(300)
  }
}

// ---------------------------------------------------------------------------
// suspend

export interface SuspendInput {
  tabId: string
  blockId: string
  name: string
  sessionId: string
  dir: string
  backend?: string
  configDir?: string
  permissionMode?: PermissionMode
  color?: string | null
  /** The Claude to stop, or undefined when the tab is already at a shell. */
  claudePid?: number
  /** Colour for the suspended tab (undefined leaves it alone). */
  suspendedColor?: string | null
  killTimeoutMs?: number
}

/**
 * Stop the Claude in a tab and leave the placeholder in its place.
 *
 * The order is what keeps it recoverable: the registry record is written
 * before anything is stopped, so a suspend interrupted halfway leaves a record
 * that `restore` and `sessions` can still act on, not a tab nobody can name.
 */
export async function suspendTab(adapter: TerminalAdapter, s: SuspendInput): Promise<{ tabId: string; recreated: boolean }> {
  placeholderShellOrThrow()
  const rec = {
    sessionId: s.sessionId,
    name: s.name,
    dir: s.dir,
    backend: s.backend,
    configDir: s.configDir,
    permissionMode: s.permissionMode,
    // Only remember a colour to restore if we are about to change it.
    ...(s.suspendedColor !== undefined ? { color: s.color ?? null } : {}),
  }
  writeRecord({ ...rec, tabId: s.tabId, suspendedAt: new Date().toISOString() })

  if (s.claudePid !== undefined) {
    try { process.kill(s.claudePid, 'SIGTERM') } catch { /* already gone */ }
    const deadline = Date.now() + (s.killTimeoutMs ?? 20_000)
    while (pidAlive(s.claudePid) && Date.now() < deadline) await sleep(250)
    if (pidAlive(s.claudePid)) {
      removeRecord(s.sessionId)
      throw new Error(`Claude (pid ${s.claudePid}) did not exit within ${(s.killTimeoutMs ?? 20_000) / 1000}s — tab left as it was.`)
    }
    // Let the tab's launch line reach its trailing `exec $SHELL -l -i` and
    // draw a prompt; the placeholder is typed into that shell.
    await sleep(2000)
  }

  const stillThere = adapter.blocksList().some((b) => b.tabid === s.tabId)
  let tabId = s.tabId
  let recreated = false
  if (stillThere) {
    await installPlaceholderInShell(adapter, s.blockId, s.tabId, rec)
  } else {
    // The tab ran Claude as its only process (not a cctabs-launched tab) and
    // closed with it. Put a placeholder tab back under the same name.
    tabId = await openPlaceholderTab(adapter, rec, { color: s.suspendedColor !== undefined ? s.suspendedColor : s.color })
    recreated = true
  }

  const up = await waitForPlaceholder(s.sessionId)
  if (up === false) {
    throw new Error(
      `Stopped Claude, but no placeholder for ${s.sessionId.slice(0, 8)}… appeared in the process table. ` +
      `The registry still has it, so \`cctabs resume ${s.name}\` or \`cctabs restore\` can bring it back.`,
    )
  }
  if (s.suspendedColor !== undefined && !recreated) await applyTabColor(adapter, tabId, s.suspendedColor)
  return { tabId, recreated }
}

// ---------------------------------------------------------------------------
// wake

export interface WakeTarget {
  blockId: string
  tabId: string
  name: string
  record: SuspendRecord
}

export interface WakeResult {
  ok: boolean
  /**
   * `confirmed` — Claude's input was seen ready on screen.
   * `assumed` — the process started but the tab's output can't be read, so
   *   readiness is a timed guess; a caller delivering a message must verify it
   *   against the transcript instead.
   */
  ready?: 'confirmed' | 'assumed'
  detail: string
}

/**
 * A view of the adapter whose scrollback starts at THIS wake's echo line.
 *
 * A suspended tab's buffer still holds the Claude that ran there before —
 * footer, mode pill, the lot — and every "is Claude ready?" check in this
 * codebase reads a tail. Without scoping, a tab whose placeholder printed only
 * two lines reads as ready before Claude has even started, and the dialogs
 * below it are never looked for.
 */
function scopedAfter(adapter: TerminalAdapter, blockId: string, token: string): { view: TerminalAdapter; seen: () => boolean } {
  let seenOnce = false
  const scrollback = (id: string, n = 50): string => {
    const full = adapter.scrollback(id, 3000)
    if (id !== blockId) return full.split('\n').slice(-n).join('\n')
    const lines = full.split('\n')
    let at = -1
    for (let i = lines.length - 1; i >= 0; i--) {
      if (stripWs(lines[i]).includes(token)) { at = i; break }
    }
    if (at >= 0) seenOnce = true
    // The echo scrolled out of the ring under a large history repaint: by then
    // everything left in the buffer is newer than the wake, so the raw tail is
    // safe to read.
    if (at < 0) return seenOnce ? lines.slice(-n).join('\n') : ''
    return lines.slice(at + 1).slice(-n).join('\n')
  }
  const view = new Proxy(adapter, {
    get(target, prop, receiver) {
      if (prop === 'scrollback') return scrollback
      const v = Reflect.get(target, prop, receiver)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
  return { view, seen: () => seenOnce }
}

const pickerVisible = (s: string) => /Resumefromsummary/i.test(stripWs(s)) && /Resumefullsession/i.test(stripWs(s))

/**
 * Wake a suspended tab and wait until Claude is at a ready prompt.
 *
 * The keypress is the easy part. What makes this worth a function is
 * everything between the keypress and a usable input box, each of which has
 * already stranded a restored tab:
 *
 *   - the folder-trust dialog, whose FIRST option is now "No, exit" — answered
 *     by clearStartupDialogs, which locates Yes and verifies the cursor before
 *     pressing Enter;
 *   - the auto-mode dialog;
 *   - the resume picker for large or old sessions, where the answer must be the
 *     full session, not a summary — confirmResumePicker, reused as is;
 *   - the MCP approval prompt, which is deliberately NOT answered: the wake
 *     fails and says so, instead of stalling silently.
 *
 * Readiness needs the footer seen twice in a row, in output newer than the
 * wake. When the tab's output can't be read at all, the process table is the
 * only evidence: a Claude launched on this session. That is reported as
 * `assumed`, never as `confirmed`.
 */
export async function wakeSuspendedTab(
  adapter: TerminalAdapter,
  t: WakeTarget,
  opts: { timeoutMs?: number } = {},
): Promise<WakeResult> {
  const timeoutMs = opts.timeoutMs ?? 120_000
  const started = Date.now()
  const deadline = started + timeoutMs
  const sessionId = t.record.sessionId.toLowerCase()
  const launched = (): boolean | undefined => {
    const rows = readProcessTable()
    return rows ? liveSessionPids(rows).has(sessionId) : undefined
  }

  const nonce = wakeNonce()
  // Match on "(nonce)" as the placeholder prints it — the bare nonce also
  // appears in the tty's echo of what we typed, before the wake happened.
  const token = `(${nonce})`
  const { view, seen } = scopedAfter(adapter, t.blockId, token)

  await adapter.sendInput(t.blockId, '\x15' + nonce)
  await sleep(150)
  await adapter.sendInput(t.blockId, '\r')

  // -- 1. did the placeholder take the keypress? --
  let took = false
  while (Date.now() < started + 20_000) {
    await sleep(400)
    view.scrollback(t.blockId, 5)
    if (seen() || launched()) { took = true; break }
  }
  if (!took) {
    const canTell = launched() !== undefined
    return {
      ok: false,
      detail: canTell
        ? `"${t.name}" did not respond to the wake keypress within 20s — no Claude started for ${sessionId.slice(0, 8)}…. Open the tab to see what's in it.`
        : `"${t.name}" gave no sign of waking within 20s, and there's no process table to check.`,
    }
  }
  if (t.record.sessionId) removeRecord(t.record.sessionId)
  // Restore the tab's own colour, if suspending had changed it.
  if (t.record.color !== undefined) {
    try { await applyTabColor(adapter, t.tabId, t.record.color) } catch { /* cosmetic */ }
  }

  // -- 2. drive it to a ready prompt --
  let readyStreak = 0
  let pickerHandled = false
  let dialogPasses = 0
  while (Date.now() < deadline) {
    const tail = view.scrollback(t.blockId, 60)

    if (!tail.trim()) {
      // Nothing readable after the wake. Fall back on the process.
      if (!seen() && launched() && Date.now() - started > 15_000) {
        return { ok: true, ready: 'assumed', detail: 'Claude started, but its output could not be read, so readiness was not confirmed on screen' }
      }
      await sleep(700)
      continue
    }

    if (mcpApprovalDialogVisible(tail)) {
      return { ok: false, detail: `"${t.name}" is waiting on an MCP server approval prompt. cctabs does not answer that one for you — open the tab and choose.` }
    }

    if (claudeInputReady(tail)) {
      if (++readyStreak >= 2) return { ok: true, ready: 'confirmed', detail: 'Claude is at its prompt' }
      await sleep(800)
      continue
    }
    readyStreak = 0

    if ((trustDialogVisible(tail) || autoModeDialogVisible(tail)) && dialogPasses < 3) {
      dialogPasses++
      // The session is being resumed in the directory it last ran in, so the
      // folder is one the user already trusted once.
      const cleared = await clearStartupDialogs(view, t.blockId, { trusted: true, dir: t.record.dir })
      if (!cleared) {
        return { ok: false, detail: `"${t.name}" is stuck on a startup dialog that could not be answered safely — open the tab and answer it (choose "Yes, I trust this folder").` }
      }
      continue
    }

    if (pickerVisible(tail) && !pickerHandled) {
      pickerHandled = true
      await confirmResumePicker(view, t.blockId, { trusted: true, dir: t.record.dir })
      continue
    }

    // Claude gone after the wake took: it quit (a "No" on some dialog, a bad
    // flag, a missing directory). Report it rather than waiting out the clock.
    if (Date.now() - started > 20_000 && launched() === false) {
      const last = tail.split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' ⏎ ')
      return { ok: false, detail: `Claude exited during the wake of "${t.name}". Last output: ${last.slice(0, 240)}` }
    }
    await sleep(700)
  }

  return {
    ok: false,
    detail: `"${t.name}" woke but Claude was not seen at a ready prompt within ${Math.round(timeoutMs / 1000)}s. Open the tab to see what it's waiting on.`,
  }
}

/**
 * Put a placeholder back into a dormant suspended tab — registered, but with
 * no placeholder process to wake — keeping the tab's place in the bar.
 *
 * The replacement is a new tab (a tab with no process has no shell to type
 * into), moved into the old one's slot before the old one is closed, so the
 * bar never visibly reshuffles. Returns the new target.
 */
export async function reviveDormant(
  adapter: TerminalAdapter,
  t: WakeTarget,
  data: Pick<AllData, 'workspaces' | 'tabsById'>,
): Promise<WakeTarget> {
  const rec = t.record
  const tabId = await openPlaceholderTab(adapter, {
    sessionId: rec.sessionId,
    name: rec.name,
    dir: rec.dir,
    backend: rec.backend,
    configDir: rec.configDir,
    permissionMode: rec.permissionMode,
    ...(rec.color !== undefined ? { color: rec.color } : {}),
  })
  if (adapter.reorderTabs) {
    const order = data.workspaces.flatMap((w) => w.workspacedata.tabids).map((id) => (id === t.tabId ? tabId : id))
    try { await adapter.reorderTabs(order) } catch { /* order is cosmetic */ }
  }
  for (const b of data.tabsById.get(t.tabId) ?? []) adapter.deleteBlock(b.blockid)
  if (!(await waitForPlaceholder(rec.sessionId))) {
    throw new Error(`Recreated "${rec.name}" as a placeholder, but it did not come up.`)
  }
  const block = adapter.blocksList().find((b) => b.tabid === tabId && b.view === 'term')
  if (!block) throw new Error(`Recreated "${rec.name}", but its new tab has no terminal.`)
  return { ...t, tabId, blockId: block.blockid, record: { ...rec, tabId } }
}

/** Log line for a successful wake. */
export function reportWake(name: string, r: WakeResult): void {
  if (r.ready === 'assumed') consola.warn(`Woke "${name}" — ${r.detail}`)
  else consola.success(`Woke "${name}" — ${r.detail}`)
}
