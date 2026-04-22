import { createConnection, type Socket } from 'net'
import { execFileSync, spawnSync } from 'child_process'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { Block, Workspace, AllData } from '../types/index.js'
import { detectTerminal, printUnsupportedTerminalError } from './terminal.js'

const SOCK_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'waveterm',
  'wave.sock',
)

// ---------------------------------------------------------------------------
// Wave unix socket RPC
// ---------------------------------------------------------------------------

interface RpcMessage {
  command: string
  reqid: string
  route: string
  source?: string
  data?: unknown
}

class WaveSocket {
  private socket: Socket
  private buffer = ''
  private pendingReaders: Array<(msg: unknown) => void> = []
  private routeId = ''
  private jwt: string

  constructor(jwt: string) {
    this.jwt = jwt
    this.socket = createConnection(SOCK_PATH)
    this.socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let nl: number
      while ((nl = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, nl).trim()
        this.buffer = this.buffer.slice(nl + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          this.pendingReaders.shift()?.(msg)
        } catch {
          // skip malformed lines
        }
      }
    })
  }

  private waitForMessage(timeoutMs = 8000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.pendingReaders.indexOf(resolve as (m: unknown) => void)
        if (idx !== -1) this.pendingReaders.splice(idx, 1)
        reject(new Error('Wave socket timeout'))
      }, timeoutMs)

      this.pendingReaders.push((msg) => {
        clearTimeout(timer)
        resolve(msg as Record<string, unknown>)
      })
    })
  }

  private send(msg: RpcMessage): void {
    this.socket.write(JSON.stringify(msg) + '\n')
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve)
      this.socket.once('error', reject)
    })

    this.send({
      command: 'authenticate',
      reqid: randomUUID(),
      route: '$control',
      data: this.jwt,
    })

    const resp = await this.waitForMessage()
    this.routeId = (resp.data as Record<string, string>).routeid
  }

  async command(
    command: string,
    data: unknown,
    route = 'wavesrv',
  ): Promise<Record<string, unknown> | null> {
    this.send({ command, reqid: randomUUID(), route, source: this.routeId, data })
    try {
      return await this.waitForMessage()
    } catch {
      return null
    }
  }

  destroy(): void {
    this.socket.destroy()
  }
}

// ---------------------------------------------------------------------------
// Wave adapter (public API)
// ---------------------------------------------------------------------------

export class WaveAdapter {
  private socket: WaveSocket | null = null
  private jwt: string

  constructor() {
    this.jwt = process.env.WAVETERM_JWT ?? ''
  }

  // -- wsh subprocess helpers --

  blocksList(): Block[] {
    try {
      // Default `wsh` RPC timeout is 5s, which is too tight when many tabs
      // are open (the response payload grows, as does the work on the daemon
      // side). Passing --timeout here gives us room before a silent failure.
      const out = execFileSync('wsh', ['blocks', 'list', '--json', '--timeout', '15000'], {
        encoding: 'utf-8',
      })
      return JSON.parse(out) as Block[]
    } catch {
      return []
    }
  }

  scrollback(blockId: string, lastN = 50): string {
    const r = spawnSync(
      'wsh',
      ['termscrollback', '-b', blockId, '--start', `-${lastN}`],
      { encoding: 'utf-8' },
    )
    return r.stdout ?? ''
  }

  /** Poll scrollback to confirm it really is empty (block has no live shell).
   * A freshly-opened tab may briefly have empty scrollback before the prompt
   * renders, so poll a few times before declaring the block dead. */
  async confirmScrollbackEmpty(blockId: string, attempts = 3, intervalMs = 500): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      const sb = this.scrollback(blockId, 10)
      if (sb.trim()) return false
      if (i < attempts - 1) await sleep(intervalMs)
    }
    return true
  }

  /** Detect whether a Claude session is running in a terminal block */
  detectSessionStatus(blockId: string): import('../types/index.js').SessionStatus {
    const tail = this.scrollback(blockId, 10)
    if (!tail.trim()) return 'unknown'

    const tailLines = tail.split('\n').map((l) => l.trim()).filter(Boolean)
    const lastLine = tailLines.at(-1) ?? ''

    // Shell prompt at the end means Claude is NOT running, regardless of
    // what appears earlier in the scrollback (stale output after exit/reboot)
    if (/[$%>]\s*$/.test(lastLine) && !lastLine.includes('claude')) {
      return 'terminal'
    }

    if (
      ['Claude Code', 'claude.ai/code', '✻ Thinking', '✽ Hatching', '⏵⏵ bypass'].some(
        (s) => tail.includes(s),
      )
    ) {
      return 'active'
    }
    if (lastLine.toLowerCase().includes('claude')) {
      return 'idle'
    }
    return 'terminal'
  }

  deleteBlock(blockId: string): void {
    spawnSync('wsh', ['deleteblock', '-b', blockId], { encoding: 'utf-8' })
  }

  async newTab(focusWindowId?: string): Promise<boolean> {
    if (focusWindowId) {
      await this.focusWindow(focusWindowId)
      await sleep(300)
    }

    const r = spawnSync(
      'osascript',
      [
        '-e',
        [
          'tell application "Wave" to activate',
          'delay 0.25',
          'tell application "System Events" to keystroke "t" using command down',
        ].join('\n'),
      ],
      { encoding: 'utf-8' },
    )

    if (r.status !== 0) {
      const msg = r.stderr?.trim()
      throw new Error(
        msg
          ? `osascript failed: ${msg}`
          : 'Failed to open new tab — ensure Wave Terminal has Accessibility permission:\n  System Settings → Privacy & Security → Accessibility → Wave ✓',
      )
    }
    return true
  }

  async waitForNewBlock(
    beforeIds: Set<string>,
    timeoutMs = 15_000,
  ): Promise<{ blockId: string; tabId: string } | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await sleep(250)
      for (const b of this.blocksList()) {
        if (b.view === 'term' && !beforeIds.has(b.blockid)) {
          return { blockId: b.blockid, tabId: b.tabid }
        }
      }
    }
    return null
  }

  // -- socket RPC methods --

  private async sock(): Promise<WaveSocket> {
    if (!this.socket) {
      const s = new WaveSocket(this.jwt)
      await s.connect()
      this.socket = s
    }
    return this.socket
  }

  closeSocket(): void {
    this.socket?.destroy()
    this.socket = null
  }

  async getTab(tabId: string): Promise<Record<string, unknown>> {
    const s = await this.sock()
    const r = await s.command('gettab', tabId)
    return (r?.data as Record<string, unknown>) ?? {}
  }

  async workspaceList(): Promise<Workspace[]> {
    const s = await this.sock()
    const r = await s.command('workspacelist', null)
    return (r?.data as Workspace[]) ?? []
  }

  async focusWindow(windowId: string): Promise<void> {
    const s = await this.sock()
    await s.command('focuswindow', windowId, 'electron')
  }

  async renameTab(tabId: string, name: string): Promise<void> {
    const s = await this.sock()
    await s.command('updatetabname', { args: [tabId, name] })
  }

  async sendInput(blockId: string, text: string): Promise<Record<string, unknown> | null> {
    const s = await this.sock()
    const inputdata64 = Buffer.from(text).toString('base64')
    return s.command('controllerinput', { blockid: blockId, inputdata64 })
  }

  // -- high-level helpers --

  async getAllData(): Promise<AllData> {
    const blocks = this.blocksList()

    const tabsById = new Map<string, Block[]>()
    for (const b of blocks) {
      const arr = tabsById.get(b.tabid) ?? []
      arr.push(b)
      tabsById.set(b.tabid, arr)
    }

    const tabNames = new Map<string, string>()
    let workspaces: Workspace[] = []

    try {
      for (const tabId of tabsById.keys()) {
        const td = await this.getTab(tabId)
        tabNames.set(tabId, (td.name as string) ?? tabId.slice(0, 8))
      }
      workspaces = await this.workspaceList()
    } catch {
      // fall through to env-based fallback
    } finally {
      this.closeSocket()
    }

    if (!workspaces.length) {
      const wsId = process.env.WAVETERM_WORKSPACEID ?? ''
      workspaces = [
        {
          workspacedata: {
            oid: wsId,
            name: wsId.slice(0, 8) || 'default',
            tabids: [...tabsById.keys()],
          },
          windowid: '',
        },
      ]
    }

    return { blocks, tabsById, workspaces, tabNames }
  }

  resolveTab(
    query: string,
    tabsById: Map<string, Block[]>,
    tabNames: Map<string, string>,
  ): string[] {
    const q = query.toLowerCase()
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
    query: string,
  ): Array<{ data: Workspace['workspacedata']; windowId: string }> {
    const q = query.toLowerCase()
    const exact = workspaces.filter(
      ({ workspacedata: wd }) => (wd.name ?? '').toLowerCase() === q,
    )
    const pool = exact.length > 0
      ? exact
      : workspaces.filter(({ workspacedata: wd }) => {
          const name = wd.name ?? ''
          return wd.oid.startsWith(query) || name.toLowerCase().startsWith(q)
        })
    return pool.map((w) => ({ data: w.workspacedata, windowId: w.windowid }))
  }
}

export function requireWaveAdapter(): WaveAdapter {
  if (!process.env.WAVETERM_JWT) {
    printUnsupportedTerminalError(detectTerminal())
    process.exit(1)
  }
  return new WaveAdapter()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
