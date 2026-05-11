import { spawnSync } from 'child_process'
import type {
  AllData,
  Block,
  SessionStatus,
  Workspace,
  WorkspaceData,
} from '../types/index.js'
import type { TerminalAdapter } from './adapter.js'

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
 * In Tabby's data model there are no Wave-style "workspaces" or "blocks";
 * we project a single synthetic workspace and a 1:1 tab↔block mapping so
 * the rest of cctabs sees the same shape it does on Wave.
 */
export class TabbyAdapter implements TerminalAdapter {
  private host: string
  private port: number
  private cachedSelfUuid: string | null = null
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
    // Synchronous in WaveAdapter; we deopt to a sync curl spawn here so the
    // existing command code can keep its synchronous shape.
    const out = spawnSync(
      'curl',
      ['-fsS', '--max-time', '5', this.url('/api/tabs')],
      { encoding: 'utf-8' },
    )
    if (out.status !== 0 || !out.stdout) return []
    let parsed: { tabs: Array<{ uuid: string; type: string; cwd?: string | null }> }
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
    // Tabby returns the literal last-N rows of the terminal viewport. Claude
    // Code's UI renders with blank padding below the prompt, so the bottom 10
    // rows are usually empty. Read enough rows to cover the full Claude UI
    // (status line, prompt, recap area).
    const tail = this.scrollback(blockId, 200)
    if (!tail.trim()) return 'unknown'

    const tailLines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
    const lastLine = tailLines.at(-1) ?? ''

    if (/[$%>]\s*$/.test(lastLine) && !lastLine.includes('claude')) {
      return 'terminal'
    }

    // Tabby's buffer endpoint can drop spaces between adjacent characters
    // depending on how Claude rendered them, so match against a
    // whitespace-stripped copy of the tail using whitespace-stripped markers.
    const compact = tail.replace(/\s+/g, '')
    const markers = [
      'Claude Code',
      'claude.ai/code',
      '⏵⏵ bypass',
      '⏵⏵ auto',
      // Spinner labels Claude Code emits while a turn is in flight. These
      // dominate the buffer during long thinks and push the status line
      // out of the readable window.
      'Thinking',
      'Hatching',
      'Composing',
      'Cogitating',
      'Befuddling',
      'Worked for',
      'Baked for',
      'Churned for',
      'Cooked for',
      'high effort',
    ]
    if (markers.some((m) => compact.includes(m.replace(/\s+/g, '')))) {
      return 'active'
    }
    // Claude Code spinner glyphs cycle through these regardless of label.
    if (/[✻✽✶✳✢]/.test(tail)) return 'active'
    if (lastLine.toLowerCase().includes('claude')) return 'idle'
    return 'terminal'
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
          tabNames.set(t.uuid, t.customTitle || t.title || t.uuid.slice(0, 8))
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
  ): string[] {
    const q = query.toLowerCase()

    if (query === '.' || query === 'self') {
      const self = this.identifySelf()
      return self ? [self] : []
    }

    const ids = [...tabsById.keys()]
    const exact = ids.filter(
      (tid) => (tabNames.get(tid) ?? '').toLowerCase() === q,
    )
    if (exact.length > 0) return exact
    return ids.filter((tid) => {
      const name = tabNames.get(tid) ?? ''
      return tid.startsWith(query) || name.toLowerCase().startsWith(q)
    })
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
