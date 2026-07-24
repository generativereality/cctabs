import { Injectable } from '@angular/core'
import { ConfigService, AppService, BaseTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { TerminalTabComponent } from 'tabby-local'
import { createServer, IncomingMessage, ServerResponse, Server } from 'http'
import { TabRegistry } from './tab-registry'
import { PidIndex } from './pid-index'
import { OutputBufferStore } from './output-buffer'
import { CctabsLogger } from './logger'
import { bufferLines } from './buffer'

const PLUGIN_VERSION = '0.1.1'

/**
 * Capability tokens advertised on /api/health so the CLI can feature-detect
 * instead of version-sniffing (a user's installed plugin is often older than
 * the CLI talking to it).
 *
 * `spawn-waits-for-pty` — POST /api/tabs/new serialises concurrent creates and
 * does not answer until the new tab's PTY has actually spawned. Callers may
 * fire creates in parallel only when this is present; without it they must
 * create tabs one at a time with a settle gap. See openNewTab().
 */
const PLUGIN_CAPABILITIES = ['spawn-waits-for-pty']

function sleep (ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * True when the given command path looks like a shell that supports the `-l`
 * login-shell flag (zsh, bash, sh, dash, ash, ksh). We err on the side of not
 * adding `-l` for unfamiliar commands — passing flags an interpreter doesn't
 * understand makes the spawn fail.
 */
function isLoginCapableShell (command: string): boolean {
  const base = command.split('/').pop() ?? ''
  return /^(zsh|bash|sh|dash|ash|ksh|mksh|fish)$/.test(base)
}

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
    private output: OutputBufferStore,
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
      return sendJson(res, 200, { ok: true, version: PLUGIN_VERSION, capabilities: PLUGIN_CAPABILITIES })
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

    if (method === 'POST' && path === '/api/tabs/reorder') {
      const body = await readJsonBody(req)
      const order: string[] = Array.isArray(body?.order) ? body.order.map(String) : []
      this.reorderTabs(order)
      return sendJson(res, 200, {})
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
      // app.closeTab() only accepts top-level tabs. Walk up to find the
      // SplitTabComponent (or other wrapper) that lives in app.tabs.
      let target: BaseTabComponent = tab
      while (!this.app.tabs.includes(target) && (target as any).parent) {
        target = (target as any).parent
      }
      await this.app.closeTab(target, false)
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
      const text = this.output.read(tab)
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
          // Session exposes getChildProcesses but not getTruePID; the pty
          // field is private but accessible at runtime.
          const pty: any = session?.pty
          if (pty?.getTruePID) pid = await pty.getTruePID()
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

  /**
   * Tail of the serialised tab-creation chain. See openNewTab().
   */
  private openTabQueue: Promise<unknown> = Promise.resolve()

  /**
   * Create a tab, one at a time, and don't answer until its PTY is running.
   *
   * Both halves matter, and they exist because of how a terminal tab actually
   * reaches the point of spawning its process:
   *
   *   TerminalTabComponent.onFrontendReady() → initializeSession() → PTY spawn
   *
   * onFrontendReady only fires once the xterm frontend has attached, and
   * BaseTerminalTabComponent.ngOnInit defers that attach into a setImmediate
   * that either attaches straight away (if the tab already hasFocus) or else
   * waits on `focused$.pipe(first())`. Meanwhile AppService.addTabRaw() →
   * selectTab() blurs the outgoing tab *synchronously* but emits focus via
   * `setImmediate(() => this._activeTab?.emitFocused())` — reading _activeTab
   * at callback time, not at schedule time.
   *
   * So two creates landing in the same event-loop turn interleave as:
   * ngOnInit(A) (queues attach-on-focus), selectTab(A) (queues focus),
   * ngOnInit(B), selectTab(B) — and when A's deferred emitFocused finally runs,
   * `_activeTab` is already B. Tab A is never focused, never attaches, and
   * therefore *never spawns a PTY at all* — it just sits there blank until you
   * click it. That is the race that forced callers into serial-with-settle.
   *
   * Serialising here plus waiting for `session.open` removes it at the source:
   * concurrent callers queue up, and each create is finished — process running,
   * not merely "tab exists" — before the next one can steal activation.
   * Advertised as the `spawn-waits-for-pty` capability.
   */
  private openNewTab (body: any): Promise<string> {
    const run = (): Promise<string> => this.openNewTabNow(body)
    // Chain off both fulfilment and rejection so one failed create doesn't
    // wedge every subsequent one.
    const result = this.openTabQueue.then(run, run)
    this.openTabQueue = result.then(() => {}, () => {})
    return result
  }

  /**
   * Wait until a freshly created terminal tab has actually spawned its process.
   *
   * Nudges with selectTab() if the PTY hasn't appeared: when the tab is still
   * active that re-emits `focused$` (selectTab's same-tab early return), which
   * is precisely the signal a tab that missed its focus event is blocked on;
   * when something else took over in the meantime it brings the tab back so it
   * can attach. Returns false on timeout — the tab is still usable, so the
   * caller reports it rather than failing the create.
   */
  private async waitForSessionStart (tab: BaseTabComponent, timeoutMs = 20_000): Promise<boolean> {
    if (!(tab instanceof BaseTerminalTabComponent)) return true
    const deadline = Date.now() + timeoutMs
    let nextNudge = Date.now() + 750
    while (Date.now() < deadline) {
      if ((tab as any).session?.open) return true
      if (Date.now() >= nextNudge) {
        this.app.selectTab(tab)
        nextNudge = Date.now() + 1500
      }
      await sleep(50)
    }
    this.logger.warn(`tab ${this.tabs.uuidOf(tab) ?? '?'} did not start its process within ${timeoutMs}ms`)
    return false
  }

  private async openNewTabNow (body: any): Promise<string> {
    // tabby-local's TerminalTabComponent expects { profile: LocalProfile }
    // where the profile carries { options: { command, args, cwd, env } }.
    //
    // Default to a login shell so /etc/zprofile (and therefore path_helper on
    // macOS) runs and PATH picks up /usr/local/bin, /opt/homebrew/bin, etc.
    // Without this, tabs spawned by cctabs miss Node/Homebrew binaries and
    // anything that shells out to `npx` (Claude Code's Bash tool, plugin MCP
    // servers, cctabs itself) fails with ENOENT. Tabby's own shell providers
    // (tabby-electron/src/shells/macDefault.ts → args: ['--login'],
    // posix.ts → args: ['-l']) pass -l by default for the same reason; this
    // matches their behaviour for tabs we construct ourselves. Callers can
    // override by passing an explicit `args` array (including `[]`).
    const command = body?.command ?? process.env.SHELL ?? '/bin/zsh'
    const defaultArgs = isLoginCapableShell(command) ? ['-l'] : []
    const profile: any = {
      type: 'local',
      name: body?.title ?? '',
      options: {
        command,
        args: body?.args ?? defaultArgs,
        cwd: body?.cwd ?? null,
        env: {},
      },
    }
    const params: any = {
      type: TerminalTabComponent,
      inputs: { profile },
    }
    // Capture the active tab *before* opening — openNewTabRaw appends the new
    // tab and makes it active, so we'd lose the reference otherwise.
    const prevActive = this.app.activeTab
    const tab = this.app.openNewTabRaw(params)
    if (body?.title) {
      tab.customTitle = body.title
      tab.setTitle(body.title)
    }
    // `afterActive`: move the freshly-appended tab to sit right after the tab
    // that was active when it was created (browser-style "open next to me"),
    // instead of at the far end of the bar. Restore intentionally omits this
    // and reorders the whole bar at the end via /api/tabs/reorder instead.
    if (body?.afterActive && prevActive) {
      const from = this.app.tabs.indexOf(tab)
      const to = this.app.tabs.indexOf(prevActive) + 1
      if (from >= 0 && to >= 0 && from !== to) {
        this.app.tabs.splice(from, 1)
        this.app.tabs.splice(from < to ? to - 1 : to, 0, tab)
        this.app.emitTabsChanged()
      }
    }
    // Force a tree walk so the new tab gets a UUID assigned.
    this.tabs.entries()
    const uuid = this.tabs.uuidOf(tab)
    if (!uuid) throw new Error('failed to register new tab')
    // Hold the response until the process is up — see openNewTab().
    await this.waitForSessionStart(tab)
    return uuid
  }

  /**
   * Reorder app.tabs to match the given list of cctabs tab uuids. Tabs whose
   * uuid isn't in `order` keep their relative order and sort after the listed
   * ones (stable sort). Mirrors how Tabby's own moveSelectedTab* mutate
   * app.tabs — splice/sort in place, then emitTabsChanged. Used by restore to
   * rebuild the pre-reboot tab order after recreating dead tabs (which append).
   */
  private reorderTabs (order: string[]): void {
    const rank = new Map(order.map((u, i) => [u, i] as const))
    const rankOf = (t: BaseTabComponent): number => {
      const u = this.tabs.uuidOf(t)
      return u && rank.has(u) ? rank.get(u)! : Number.MAX_SAFE_INTEGER
    }
    this.app.tabs.sort((a, b) => rankOf(a) - rankOf(b))
    this.app.emitTabsChanged()
  }
}
