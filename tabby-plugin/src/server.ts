import { Inject, Injectable } from '@angular/core'
import { ConfigService, AppService, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { TabRegistry } from './tab-registry'
import { PidIndex } from './pid-index'
import { CctabsLogger } from './logger'
import { serializeBuffer, bufferLines } from './buffer'

const PLUGIN_VERSION = '0.1.0'

interface TabInfo {
  uuid: string
  title: string
  customTitle?: string
  hasFocus: boolean
  type: string
  cwd?: string | null
  pid?: number
}

/** Body parser — collects request body up to a small cap. */
function readJsonBody (req: IncomingMessage, cap = 1_000_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (c: Buffer) => {
      total += c.length
      if (total > cap) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function sendJson (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

@Injectable({ providedIn: 'root' })
export class CctabsServer {
  private server: Server | null = null

  constructor (
    private app: AppService,
    private config: ConfigService,
    private tabs: TabRegistry,
    private pids: PidIndex,
    private logger: CctabsLogger,
  ) {
    this.start()

    // Restart server on config change so port edits take effect
    this.config.changed$.subscribe(() => this.restart())
  }

  start (): void {
    const cfg = this.config.store?.cctabs ?? {}
    const port: number = cfg.port ?? 3300
    const host: string = cfg.host ?? '127.0.0.1'

    this.server = createServer((req, res) => this.handle(req, res).catch(err => {
      this.logger.error('handler error', err)
      try { sendJson(res, 500, { error: String(err?.message ?? err) }) } catch {}
    }))

    this.server.on('error', err => this.logger.error('server error', err))
    this.server.listen(port, host, () => {
      this.logger.info(`HTTP API listening on http://${host}:${port}`)
    })
  }

  stop (): void {
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  restart (): void {
    this.stop()
    this.start()
  }

  // ---- routing ----

  private async handle (req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === '/api/health') {
      return sendJson(res, 200, { ok: true, version: PLUGIN_VERSION })
    }

    if (method === 'GET' && path === '/api/tabs') {
      return sendJson(res, 200, { tabs: await this.listTabs() })
    }

    if (method === 'POST' && path === '/api/tabs/identify') {
      const body = await readJsonBody(req)
      const pids: number[] = Array.isArray(body?.pids) ? body.pids : []
      const uuid = await this.pids.lookup(pids)
      if (!uuid) return sendJson(res, 404, { error: 'no matching tab' })
      return sendJson(res, 200, { uuid })
    }

    if (method === 'POST' && path === '/api/tabs/new') {
      const body = await readJsonBody(req)
      const uuid = await this.openNewTab(body)
      return sendJson(res, 200, { uuid })
    }

    // /api/tabs/:uuid/...
    const match = /^\/api\/tabs\/([^/]+)(?:\/(.*))?$/.exec(path)
    if (match) {
      const uuid = match[1]
      const sub = match[2] ?? ''
      const tab = this.tabs.resolve(uuid)
      if (!tab) return sendJson(res, 404, { error: `unknown tab ${uuid}` })
      return this.handleTab(req, res, method, sub, url, tab)
    }

    sendJson(res, 404, { error: 'not found' })
  }

  private async handleTab (
    req: IncomingMessage,
    res: ServerResponse,
    method: string,
    sub: string,
    url: URL,
    tab: BaseTabComponent,
  ): Promise<void> {
    if (method === 'POST' && sub === 'send') {
      const body = await readJsonBody(req)
      if (!(tab instanceof BaseTerminalTabComponent)) {
        return sendJson(res, 400, { error: 'tab is not a terminal' })
      }
      tab.sendInput(String(body?.data ?? ''))
      return sendJson(res, 200, {})
    }

    if (method === 'POST' && sub === 'close') {
      await this.app.closeTab(tab, false)
      return sendJson(res, 200, {})
    }

    if (method === 'PUT' && sub === 'title') {
      const body = await readJsonBody(req)
      const title = String(body?.title ?? '')
      tab.customTitle = title
      tab.setTitle(title)
      return sendJson(res, 200, {})
    }

    if (method === 'GET' && sub === 'buffer') {
      if (!(tab instanceof BaseTerminalTabComponent)) {
        return sendJson(res, 400, { error: 'tab is not a terminal' })
      }
      const lastN = url.searchParams.get('lines')
      const text = serializeBuffer(tab)
      const lines = bufferLines(text, lastN ? Number(lastN) : undefined)
      return sendJson(res, 200, { lines, totalLines: lines.length })
    }

    if (method === 'GET' && sub === 'cwd') {
      if (!(tab instanceof BaseTerminalTabComponent)) {
        return sendJson(res, 400, { error: 'tab is not a terminal' })
      }
      let cwd: string | null = null
      try {
        const session: any = (tab as any).session
        if (session?.getWorkingDirectory) cwd = await session.getWorkingDirectory()
        if (!cwd && session?.guessedCWD) cwd = session.guessedCWD
      } catch {}
      return sendJson(res, 200, { cwd })
    }

    sendJson(res, 405, { error: `method ${method} not allowed on /api/tabs/:uuid/${sub}` })
  }

  // ---- helpers ----

  private async listTabs (): Promise<TabInfo[]> {
    const out: TabInfo[] = []
    for (const { uuid, tab } of this.tabs.entries()) {
      const isTerm = tab instanceof BaseTerminalTabComponent
      let cwd: string | null | undefined
      let pid: number | undefined
      if (isTerm) {
        const session: any = (tab as any).session
        try {
          if (session?.getWorkingDirectory) cwd = await session.getWorkingDirectory()
          if (!cwd && session?.guessedCWD) cwd = session.guessedCWD
        } catch {}
        try {
          pid = typeof session?.getPID === 'function' ? session.getPID() : session?.pid
        } catch {}
      }
      out.push({
        uuid,
        title: tab.title,
        customTitle: tab.customTitle || undefined,
        hasFocus: tab.hasFocus,
        type: isTerm ? 'terminal' : tab.constructor?.name ?? 'tab',
        cwd: cwd ?? null,
        pid,
      })
    }
    return out
  }

  private async openNewTab (body: any): Promise<string> {
    // Lazy-load TerminalTabComponent so we can fail gracefully if it's unavailable.
    const tabbyTerminal: any = require('tabby-terminal')
    const TerminalTabComponent =
      tabbyTerminal.TerminalTabComponent ?? tabbyTerminal.UnixDefaultProfile

    const params: any = {
      type: TerminalTabComponent,
      inputs: {
        command: body?.command ?? undefined,
        cwd: body?.cwd ?? undefined,
        title: body?.title ?? undefined,
      },
    }
    const tab = this.app.openNewTabRaw(params)
    if (body?.title) {
      tab.customTitle = body.title
      tab.setTitle(body.title)
    }
    // tabOpened$ has already fired synchronously; UUID is registered.
    const uuid = this.tabs.uuidOf(tab)
    if (!uuid) throw new Error('failed to register new tab')
    return uuid
  }
}
