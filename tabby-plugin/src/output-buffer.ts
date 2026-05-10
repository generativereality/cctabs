import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { CctabsLogger } from './logger'

/**
 * Per-terminal-tab output ring buffer.
 *
 * SerializeAddon-from-xterm is no good for hidden tabs — Tabby renders
 * tabs lazily and the xterm buffer of an unfocused tab can stay empty.
 * cctabs needs to read scrollback for tabs it isn't focused in (e.g. to
 * decide whether a Claude session is active in a sibling tab), so we
 * subscribe directly to each session's output$ and accumulate text.
 *
 * Capped per tab to keep memory bounded; the tail is what cctabs cares
 * about (last shell prompt, last few lines of claude scroll, etc.).
 */
@Injectable({ providedIn: 'root' })
export class OutputBufferStore {
  private buffers = new WeakMap<BaseTabComponent, string>()
  private wired = new WeakSet<BaseTabComponent>()
  private maxChars = 256 * 1024  // ~256 KB per tab

  constructor (private app: AppService, private logger: CctabsLogger) {
    for (const tab of app.tabs) this.wireTreeForTab(tab)
    app.tabOpened$.subscribe(tab => this.wireTreeForTab(tab))
  }

  read (tab: BaseTabComponent): string {
    return this.buffers.get(tab) ?? ''
  }

  /** Idempotent — wires up output capture for `tab` and any split children. */
  wireTreeForTab (tab: BaseTabComponent): void {
    this.wire(tab)
    if (tab instanceof SplitTabComponent) {
      for (const child of tab.getAllTabs()) this.wire(child)
      // SplitTabComponent doesn't expose a tab-added event publicly, but in
      // practice splits are constructed eagerly with their leaves.
    }
  }

  private wire (tab: BaseTabComponent): void {
    if (this.wired.has(tab)) return
    if (!(tab instanceof BaseTerminalTabComponent)) return
    this.wired.add(tab)
    this.logger.info('output-buffer: wiring tab', tab.title || '(no title)')

    const handle = (data: string) => {
      const cur = this.buffers.get(tab) ?? ''
      const next = cur + data
      this.buffers.set(
        tab,
        next.length > this.maxChars ? next.slice(-this.maxChars) : next,
      )
    }

    const subscribed = new WeakSet<object>()
    const subscribeToSession = (session: any): void => {
      if (!session?.output$ || subscribed.has(session)) return
      subscribed.add(session)
      this.logger.info('output-buffer: subscribed to session output$', tab.title || '(no title)')
      session.output$.subscribe(handle)
    }

    // sessionChanged$ misses past emissions, and Tabby attaches sessions
    // late for non-focused / restored tabs. Poll until a session shows up,
    // up to ~5 minutes (enough for a user to switch tabs once), then drop.
    let attempts = 0
    const maxAttempts = 600
    const tick = (): void => {
      if (tab.session) {
        subscribeToSession(tab.session)
        return
      }
      if (++attempts >= maxAttempts) return
      setTimeout(tick, 500)
    }
    tick()

    tab.sessionChanged$.subscribe(s => subscribeToSession(s))
  }
}
