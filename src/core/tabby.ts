import { spawnSync } from 'child_process'
import { consola } from 'consola'
import type {
  AllData,
  Block,
  SessionStatus,
  Workspace,
  WorkspaceData,
} from '../types/index.js'
import type { TerminalAdapter } from './adapter.js'
import { pluginTimeoutSec, isTransientCurlExit, splitCurlOutput, TabbyPluginRequestError } from './plugin-request.js'
import { readInputDraft, type DraftState, type ScreenRow } from './input-draft.js'
import { classifyTerminalBuffer } from './session-status.js'
import { authHeaders, controlTokenPath, curlAuth, readControlToken } from './control-token.js'
import { TABBY_PLUGIN } from './tabby-plugin-dir.js'
import { matchTabsByName, normalizeTabName, type TabMatchOptions } from './tab-match.js'

/**
 * Thrown when the cctabs Tabby plugin's HTTP API is unreachable.
 *
 * Failing loud here matters: if we silently returned empty data the
 * caller would conclude "no tabs" and act on it. The CLI's outer error
 * handler renders this with the install hint.
 */
export class TabbyPluginUnreachableError extends Error {
  constructor(public host: string, public port: number, public underlying?: string) {
    const lines = [
      `cctabs Tabby plugin not reachable at http://${host}:${port}.`,
      underlying ? `  reason: ${underlying}` : '',
      '',
      'Install + restart Tabby in one shot from inside a Tabby tab:',
      '  cctabs install-tabby-plugin',
      '',
      'Or do it by hand:',
      `  npm install --legacy-peer-deps --prefix "$HOME/Library/Application Support/tabby/plugins" ${TABBY_PLUGIN}`,
      '  # then quit Tabby (Cmd+Q) and reopen it.',
      '',
      'Verify with: cctabs doctor',
    ].filter(Boolean)
    super(lines.join('\n'))
    this.name = 'TabbyPluginUnreachableError'
  }
}

/** Why the plugin refuses us, and the fix. */
function tokenRefusedMessage(): string {
  return [
    `The cctabs Tabby plugin requires a control token, and there is none readable at ${controlTokenPath()}.`,
    'The plugin writes a fresh one each time Tabby starts. Restart Tabby; if this persists,',
    'check that this command runs as the same OS user as Tabby (`cctabs doctor`).',
  ].join('\n')
}

/**
 * cctabs adapter for Tabby Terminal. Talks to the tabby-cctabs
 * plugin's HTTP API (default 127.0.0.1:3300).
 *
 * Tab identity: cctabs (running inside a Tabby tab) walks its own
 * process.pid → ppid chain via `ps`, POSTs the PID list to
 * /api/tabs/identify, and caches the resulting plugin UUID.
 *
 * In Tabby's data model there are no "workspaces" or "blocks";
 * we project a single synthetic workspace and a 1:1 tab↔block mapping so
 * the rest of cctabs sees the shape the commands layer expects.
 */
export class TabbyAdapter implements TerminalAdapter {
  private host: string
  private port: number
  private cachedSelfUuid: string | null = null
  private cachedCapabilities: string[] | null = null
  private healthChecked = false

  constructor() {
    this.host = process.env.CCTABS_TABBY_HOST ?? '127.0.0.1'
    this.port = Number(process.env.CCTABS_TABBY_PORT ?? '3300')
  }

  /**
   * One-shot health check. Throws TabbyPluginUnreachableError on the
   * first call if /api/health is unreachable. Subsequent calls are no-ops
   * — once we've confirmed the plugin is up, we trust it for this process.
   */
  private ensureHealthy(): void {
    if (this.healthChecked) return
    let r
    try {
      r = this.request('GET', '/api/health', 'Checking the Tabby plugin')
    } catch (err) {
      // Busy is not absent: a plugin that's slow to answer must not get
      // "install the plugin" advice.
      if (err instanceof TabbyPluginRequestError && err.timedOut) throw err
      throw new TabbyPluginUnreachableError(this.host, this.port, (err as Error).message)
    }
    if (r.status !== 200 || !r.body) {
      throw new TabbyPluginUnreachableError(this.host, this.port, `/api/health answered HTTP ${r.status}`)
    }
    // A plugin that wants a token answers every other call with 401. Find out now, before
    // any command has started acting on the fleet, while the failure can still be explained.
    let capabilities: string[] = []
    try {
      capabilities = (JSON.parse(r.body) as { capabilities?: string[] }).capabilities ?? []
    } catch {
      // An unparseable health reply is an old plugin; it wants no token.
    }
    if (capabilities.includes('control-token') && !readControlToken()) {
      throw new Error(tokenRefusedMessage())
    }
    this.healthChecked = true
  }

  /**
   * One sync request through curl, retried once if it timed out or the
   * connection failed. Returns any HTTP answer, 404s included — those are
   * answers. Throws only when there is no answer at all, because a request
   * that failed is not an empty result (see plugin-request.ts).
   */
  private request(
    method: 'GET' | 'POST',
    path: string,
    what: string,
    opts: { body?: unknown; timeoutSec?: number; retry?: boolean } = {},
  ): { status: number; body: string } {
    const timeout = String(opts.timeoutSec ?? pluginTimeoutSec())
    const args = ['-sS', '-X', method, '--max-time', timeout, '-w', '\n%{http_code}']
    if (opts.body !== undefined) args.push('-H', 'content-type: application/json', '--data', JSON.stringify(opts.body))
    args.push(this.url(path))
    const attempts = opts.retry === false ? 1 : 2
    let last: { status: number | null; stderr: string } = { status: null, stderr: '' }
    for (let i = 0; i < attempts; i++) {
      // Read per attempt: the plugin mints a new token each time Tabby starts.
      const auth = curlAuth()
      const r = spawnSync('curl', [...auth.args, ...args], { encoding: 'utf-8', input: auth.input })
      const parsed = r.status === 0 ? splitCurlOutput(r.stdout ?? '') : null
      if (parsed?.status === 401) throw new Error(tokenRefusedMessage())
      if (parsed) return parsed
      last = { status: r.status, stderr: (r.stderr || '').trim() }
      if (!isTransientCurlExit(r.status)) break
    }
    throw new TabbyPluginRequestError(what, last.stderr || `curl exit ${last.status}`, last.status === 28)
  }

  // ---- HTTP helpers ----

  private url(path: string): string {
    return `http://${this.host}:${this.port}${path}`
  }

  private async http(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const res = await fetch(this.url(path), {
      method,
      // One connection per request. Node's fetch keeps the socket alive, and a
      // request on a socket that sat idle stalls: measured against the real
      // plugin (Node 26), ~50ms fresh but exactly +2000ms on a reused socket
      // after 1s idle, every time — and anything that polls with a sleep
      // between calls (a wake, a restore's verification, the draft guard) hits
      // exactly that. With `connection: close` the same requests take ~3ms.
      headers: { ...authHeaders(), connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401) throw new Error(tokenRefusedMessage())
    if (res.status === 404) return null
    if (!res.ok) {
      throw new Error(`Tabby plugin ${method} ${path} failed: ${res.status}`)
    }
    return res.json()
  }

  // ---- TerminalAdapter ----

  closeSocket(): void {
    // No persistent connection — fetch is one-shot. No-op.
  }

  blocksList(): Block[] {
    this.ensureHealthy()
    // We deopt to a sync curl spawn here so the
    // existing command code can keep its synchronous shape.
    const out = this.request('GET', '/api/tabs', 'Reading the tab list')
    if (out.status !== 200) throw new TabbyPluginRequestError('Reading the tab list', `HTTP ${out.status}`, false)
    let parsed: {
      tabs: Array<{
        uuid: string
        type: string
        cwd?: string | null
        pid?: number
        shellPid?: number
        color?: string | null
      }>
    }
    try {
      parsed = JSON.parse(out.body)
    } catch {
      throw new TabbyPluginRequestError('Reading the tab list', 'the plugin answered with something that is not JSON', false)
    }
    if (!Array.isArray(parsed?.tabs)) throw new TabbyPluginRequestError('Reading the tab list', 'the answer has no `tabs` list', false)
    return parsed.tabs
      .filter((t) => t.type === 'terminal')
      .map((t) => ({
        blockid: t.uuid,
        tabid: t.uuid,
        view: 'term',
        meta: t.cwd ? { 'cmd:cwd': t.cwd } : undefined,
        // Reported since plugin 0.1.x from the tab's own pty. A restored tab
        // that Tabby never focused has no pty and therefore no pid — which is
        // the genuine "no live shell" case that scrollback only ever guessed at.
        pid: typeof t.pid === 'number' ? t.pid : undefined,
        // Only plugins advertising `stable-pid` report this — see Block.shellPid.
        shellPid: typeof t.shellPid === 'number' ? t.shellPid : undefined,
        // Only plugins advertising `tab-color` report this. Left undefined
        // otherwise, which reads as "unknown" rather than "no colour set".
        color: t.color,
      }))
  }

  scrollback(blockId: string, lastN = 50): string {
    // '' on failure is deliberate here, and safe: an empty capture already
    // means "unreadable" everywhere (liveness comes from the pid, never from
    // scrollback). Shorter than the default and not retried, because a fleet
    // command reads this once per tab.
    let out
    try {
      out = this.request('GET', `/api/tabs/${blockId}/buffer?lines=${lastN}`, 'Reading a tab', {
        timeoutSec: Math.min(10, pluginTimeoutSec()),
        retry: false,
      })
    } catch {
      return ''
    }
    if (out.status !== 200 || !out.body) return ''
    try {
      const parsed = JSON.parse(out.body) as { lines: string[] }
      return parsed.lines.join('\n')
    } catch {
      return ''
    }
  }

  async confirmScrollbackEmpty(
    blockId: string,
    attempts = 3,
    intervalMs = 500,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const sb = this.scrollback(blockId, 10)
      if (sb.trim()) return false
      if (i < attempts - 1) await sleep(intervalMs)
    }
    return true
  }

  detectSessionStatus(blockId: string): SessionStatus {
    // 200 rows: Claude Code renders blank padding below its prompt, so a short
    // read is mostly empty space. The rules themselves live in
    // session-status.ts — pure, shared, and testable without a terminal.
    return classifyTerminalBuffer(this.scrollback(blockId, 200))
  }

  deleteBlock(blockId: string): void {
    const r = this.request('POST', `/api/tabs/${blockId}/close`, `Closing tab ${blockId.slice(0, 8)}`)
    // 404 is "already gone", which is what closing wanted.
    if (r.status !== 200 && r.status !== 404) {
      throw new TabbyPluginRequestError(`Closing tab ${blockId.slice(0, 8)}`, `HTTP ${r.status}`, false)
    }
  }

  async newTab(_focusWindowId?: string): Promise<boolean> {
    // Tabby has no window-level focus concept exposed by the plugin yet.
    const r = await this.http('POST', '/api/tabs/new', {})
    return Boolean(r)
  }

  async waitForNewBlock(
    beforeIds: Set<string>,
    timeoutMs = 15_000,
  ): Promise<{ blockId: string; tabId: string } | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(250)
      for (const b of this.blocksList()) {
        if (!beforeIds.has(b.blockid)) {
          return { blockId: b.blockid, tabId: b.tabid }
        }
      }
    }
    return null
  }

  async renameTab(tabId: string, name: string): Promise<void> {
    await this.http('PUT', `/api/tabs/${tabId}/title`, { title: name })
  }

  /**
   * Fast path: the plugin's POST /api/tabs/new accepts {cwd, title, command,
   * args} and returns the new tab's uuid synchronously. This collapses the
   * whole newTab → waitForNewBlock → renameTab → wait-for-shell-prompt →
   * sendInput sequence into a single round-trip, and (because the uuid is
   * returned, not discovered by diffing) lets the caller open many tabs at once.
   */
  async openTabDirect(opts: {
    cwd: string
    title: string
    command: string
    args: string[]
    afterActive?: boolean
    color?: string | null
    background?: boolean
  }): Promise<{ blockId: string; tabId: string }> {
    this.ensureHealthy()
    // Who to put back in front, read BEFORE the create makes the new tab active.
    const caller = opts.background ? this.currentTabId() : ''
    const r = (await this.http('POST', '/api/tabs/new', {
      cwd: opts.cwd,
      title: opts.title,
      command: opts.command,
      args: opts.args,
      afterActive: opts.afterActive ?? false,
      // Omitted entirely when no colour was asked for, so an older plugin sees
      // exactly the body it saw before.
      ...(opts.color !== undefined ? { color: opts.color } : {}),
    })) as { uuid?: string } | null
    const uuid = r?.uuid
    if (!uuid) throw new Error('Tabby plugin did not return a tab uuid')
    if (opts.background) {
      // The new tab had to be in front to start its process (see the plugin's
      // openNewTab); with `spawn-waits-for-pty` it is running by now, so the
      // caller can have the screen back.
      const caps = await this.backendCapabilities()
      if (!caller) consola.warn('Not inside a Tabby tab, so there is no tab to keep in front; the new tab is.')
      else if (!caps.includes('tab-focus') || !caps.includes('spawn-waits-for-pty')) consola.warn('The Tabby plugin cannot switch tabs (no `tab-focus`), so the new tab is in front. Update it: cctabs install-tabby-plugin')
      else if (caller !== uuid) await this.http('POST', `/api/tabs/${caller}/focus`)
    }
    return { blockId: uuid, tabId: uuid }
  }

  /**
   * Capabilities from /api/health. Plugins predating capability reporting
   * simply omit the field, which correctly reads as "none" — the CLI then
   * falls back to serial spawning.
   */
  async backendCapabilities(): Promise<string[]> {
    if (this.cachedCapabilities) return this.cachedCapabilities
    try {
      const r = (await this.http('GET', '/api/health')) as { capabilities?: unknown } | null
      const caps = Array.isArray(r?.capabilities) ? r!.capabilities.map(String) : []
      this.cachedCapabilities = caps
      return caps
    } catch {
      this.cachedCapabilities = []
      return []
    }
  }

  async screenText(blockId: string): Promise<string | null> {
    if (!(await this.backendCapabilities()).includes('screen')) return null
    try {
      const r = (await this.http('GET', `/api/tabs/${blockId}/screen`)) as { attached?: boolean; rows?: ScreenRow[] } | null
      return r?.attached && Array.isArray(r.rows) ? r.rows.map((x) => x.text).join('\n') : null
    } catch {
      return null
    }
  }

  async inputDraft(blockId: string): Promise<DraftState> {
    if (!(await this.backendCapabilities()).includes('screen')) {
      return { state: 'unknown', why: 'the Tabby plugin predates the `screen` capability' }
    }
    try {
      const r = (await this.http('GET', `/api/tabs/${blockId}/screen`)) as { attached?: boolean; rows?: ScreenRow[] } | null
      if (!r?.attached || !Array.isArray(r.rows)) return { state: 'unknown', why: 'the tab has never been shown, so it has no screen' }
      return readInputDraft(r.rows)
    } catch (err) {
      return { state: 'unknown', why: `could not read the screen: ${(err as Error).message}` }
    }
  }

  /**
   * Mirrors renameTab: a PUT on one field of an existing tab. Guarded by the
   * `tab-color` capability at the call site — this route 404s on a plugin that
   * predates it, and `http()` turns that into a throw.
   */
  async setTabColor(tabId: string, color: string | null): Promise<void> {
    this.ensureHealthy()
    await this.http('PUT', `/api/tabs/${tabId}/color`, { color })
  }

  async reorderTabs(order: string[]): Promise<void> {
    this.ensureHealthy()
    await this.http('POST', '/api/tabs/reorder', { order })
  }

  async sendInput(blockId: string, text: string): Promise<unknown> {
    return this.http('POST', `/api/tabs/${blockId}/send`, { data: text })
  }

  async getAllData(): Promise<AllData> {
    const blocks = this.blocksList()
    const tabsById = new Map<string, Block[]>()
    for (const b of blocks) {
      const arr = tabsById.get(b.tabid) ?? []
      arr.push(b)
      tabsById.set(b.tabid, arr)
    }

    // Tab names come from the same /api/tabs payload we already fetched in
    // blocksList(); refetch with title so we don't re-derive.
    const tabNames = new Map<string, string>()
    try {
      const res = await fetch(this.url('/api/tabs'), { headers: { ...authHeaders(), connection: 'close' } })
      if (res.ok) {
        const data = (await res.json()) as {
          tabs: Array<{ uuid: string; title: string; customTitle?: string }>
        }
        for (const t of data.tabs) {
          // Normalize here, at the one place a live OSC title enters cctabs, so
          // a tab can't change identity just because Claude started thinking.
          const name = t.customTitle || normalizeTabName(t.title ?? '')
          tabNames.set(t.uuid, name || t.uuid.slice(0, 8))
        }
      }
    } catch {
      // fall through with empty names
    }

    const data: WorkspaceData = {
      oid: 'tabby',
      name: 'tabby',
      tabids: [...tabsById.keys()],
    }
    const workspaces: Workspace[] = [{ workspacedata: data, windowid: '' }]
    return { blocks, tabsById, workspaces, tabNames }
  }

  resolveTab(
    query: string,
    tabsById: Map<string, Block[]>,
    tabNames: Map<string, string>,
    opts?: TabMatchOptions,
  ): string[] {
    if (query === '.' || query === 'self') {
      const self = this.identifySelf()
      return self ? [self] : []
    }

    return matchTabsByName(query, [...tabsById.keys()], tabNames, opts)
  }

  resolveBlock(query: string, blocks: Block[]): Block[] {
    return blocks.filter((b) => b.blockid.startsWith(query))
  }

  resolveWorkspace(
    workspaces: Workspace[],
    _query: string,
  ): Array<{ data: WorkspaceData; windowId: string }> {
    return workspaces.map((w) => ({ data: w.workspacedata, windowId: w.windowid }))
  }

  currentTabId(): string {
    return this.identifySelf() ?? ''
  }

  currentBlockId(): string {
    // Tabby has a 1:1 tab↔block mapping in our data model.
    return this.currentTabId()
  }

  currentWorkspaceId(): string {
    return 'tabby'
  }

  // ---- Tabby-specific: identify the tab cctabs is currently running in ----

  /**
   * Walk the process tree from `process.pid` upwards collecting PIDs, then
   * ask the plugin which tab owns any of them. Result is cached for the
   * lifetime of this adapter.
   */
  identifySelf(): string | null {
    if (this.cachedSelfUuid !== null) return this.cachedSelfUuid

    const pids = walkAncestorPids(process.pid)
    // A 404 is the plugin saying "none of these pids is a tab": we're not in
    // Tabby. A request that FAILED says nothing, and must not be read as that
    // — restore uses this to keep its hands off the tab it is running in.
    const out = this.request('POST', '/api/tabs/identify', 'Finding which tab cctabs is running in', { body: { pids } })
    if (out.status !== 200 || !out.body) {
      this.cachedSelfUuid = ''
      return null
    }
    try {
      const parsed = JSON.parse(out.body) as { uuid?: string }
      this.cachedSelfUuid = parsed.uuid ?? ''
      return parsed.uuid ?? null
    } catch {
      this.cachedSelfUuid = ''
      return null
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Walk `pid → ppid → ...`. Caps at 32 levels to avoid pathological loops on
 * misconfigured systems. Returns [pid, ppid, gppid, ...].
 */
export function walkAncestorPids(startPid: number, cap = 32): number[] {
  return process.platform === 'win32'
    ? walkAncestorPidsWindows(startPid, cap)
    : walkAncestorPidsPosix(startPid, cap)
}

function walkAncestorPidsPosix(startPid: number, cap: number): number[] {
  const out: number[] = [startPid]
  let cur = startPid
  for (let i = 0; i < cap; i++) {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(cur)], {
      encoding: 'utf-8',
    })
    if (r.status !== 0) break
    const next = parseInt(r.stdout.trim(), 10)
    if (!Number.isFinite(next) || next <= 1 || next === cur) break
    out.push(next)
    cur = next
  }
  return out
}

/**
 * Windows has no `ps`, and Git Bash's MSYS one does not accept `-o`
 * (`ps: unknown option -- o`, measured on Windows 11, 2026-09-17). So the
 * POSIX walk exits non-zero on its first call and returns `[self]`.
 *
 * That does not fail loudly. `/api/tabs/identify` matches the submitted pids
 * against each tab's true PID *and its direct children*, so `[self]` still
 * matches when cctabs is run straight from a tab's own shell — `whoami`
 * answers `"via": "pid"` and looks entirely healthy. One level deeper it
 * stops matching and every identity route returns null. Measured both ways on
 * the same guest: direct child → `{"tab":"intab","via":"pid"}`; the same
 * command behind one extra `cmd /c` → `{"tab":null,"via":null}`. The nested
 * case is the normal one, because cctabs is usually invoked from inside Claude
 * Code's Bash tool rather than typed at the tab's prompt.
 *
 * One CIM query returns the whole pid → ppid map, so the walk happens
 * in-process and costs a single PowerShell start rather than one per level.
 */
function walkAncestorPidsWindows(startPid: number, cap: number): number[] {
  const out: number[] = [startPid]
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
    ],
    { encoding: 'utf-8', timeout: 15000 },
  )
  if (r.status !== 0 || !r.stdout) return out

  const parent = new Map<number, number>()
  for (const line of r.stdout.split('\n')) {
    const [a, b] = line.trim().split(/\s+/)
    const pid = Number(a)
    const ppid = Number(b)
    if (Number.isFinite(pid) && Number.isFinite(ppid)) parent.set(pid, ppid)
  }

  const seen = new Set<number>([startPid])
  let cur = startPid
  for (let i = 0; i < cap; i++) {
    const next = parent.get(cur)
    if (next === undefined || next <= 0 || seen.has(next)) break
    out.push(next)
    seen.add(next)
    cur = next
  }
  return out
}
