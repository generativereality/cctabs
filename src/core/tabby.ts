import { spawnSync } from 'child_process'
import type {
  AllData,
  Block,
  SessionStatus,
  Workspace,
  WorkspaceData,
} from '../types/index.js'
import type { TerminalAdapter } from './adapter.js'
import { classifyTerminalBuffer } from './session-status.js'
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
      `  npm install --legacy-peer-deps --prefix "$HOME/Library/Application Support/tabby/plugins" tabby-cctabs`,
      '  # then quit Tabby (Cmd+Q) and reopen it.',
      '',
      'Verify with: cctabs doctor',
    ].filter(Boolean)
    super(lines.join('\n'))
    this.name = 'TabbyPluginUnreachableError'
  }
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
    const r = spawnSync(
      'curl',
      ['-fsS', '--max-time', '3', this.url('/api/health')],
      { encoding: 'utf-8' },
    )
    if (r.status !== 0 || !r.stdout) {
      const reason = (r.stderr || '').trim() || `curl exit ${r.status}`
      throw new TabbyPluginUnreachableError(this.host, this.port, reason)
    }
    this.healthChecked = true
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
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
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
    const out = spawnSync(
      'curl',
      ['-fsS', '--max-time', '5', this.url('/api/tabs')],
      { encoding: 'utf-8' },
    )
    if (out.status !== 0 || !out.stdout) return []
    let parsed: {
      tabs: Array<{
        uuid: string
        type: string
        cwd?: string | null
        pid?: number
        color?: string | null
      }>
    }
    try {
      parsed = JSON.parse(out.stdout)
    } catch {
      return []
    }
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
        // Only plugins advertising `tab-color` report this. Left undefined
        // otherwise, which reads as "unknown" rather than "no colour set".
        color: t.color,
      }))
  }

  scrollback(blockId: string, lastN = 50): string {
    const out = spawnSync(
      'curl',
      ['-fsS', '--max-time', '5', this.url(`/api/tabs/${blockId}/buffer?lines=${lastN}`)],
      { encoding: 'utf-8' },
    )
    if (out.status !== 0 || !out.stdout) return ''
    try {
      const parsed = JSON.parse(out.stdout) as { lines: string[] }
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
    spawnSync(
      'curl',
      ['-fsS', '-X', 'POST', '--max-time', '5', this.url(`/api/tabs/${blockId}/close`)],
      { encoding: 'utf-8' },
    )
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
  }): Promise<{ blockId: string; tabId: string }> {
    this.ensureHealthy()
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
      const res = await fetch(this.url('/api/tabs'))
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
    const out = spawnSync(
      'curl',
      [
        '-fsS',
        '-X',
        'POST',
        '-H',
        'content-type: application/json',
        '--max-time',
        '5',
        '--data',
        JSON.stringify({ pids }),
        this.url('/api/tabs/identify'),
      ],
      { encoding: 'utf-8' },
    )
    if (out.status !== 0 || !out.stdout) {
      this.cachedSelfUuid = ''
      return null
    }
    try {
      const parsed = JSON.parse(out.stdout) as { uuid?: string }
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
 * Walk `pid → ppid → ...` via `ps`. Caps at 32 levels to avoid pathological
 * loops on misconfigured systems. Returns [pid, ppid, gppid, ...].
 */
function walkAncestorPids(startPid: number, cap = 32): number[] {
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
