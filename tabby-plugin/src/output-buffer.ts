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

    // sessionChanged$ misses past emissions, and Tabby attaches sessions late
    // for non-focused / restored tabs — a restored tab spawns its PTY only
    // once it has been focused, which may be hours after startup or never.
    //
    // This used to give up after ~5 minutes, which quietly created permanently
    // blind tabs: the subscriber was gone by the time the session appeared, so
    // the tab's buffer stayed empty for the rest of the Tabby run no matter how
    // much Claude output flowed through it. cctabs then read that empty buffer
    // as "no session here" and offered to close the tab. One boot's log showed
    // 192 tabs wired and 147 subscribed — 45 live tabs reading as dead.
    //
    // So: never give up while the tab lives. Back off to a slow poll, which
    // costs one timer per not-yet-started tab and nothing else, and stop on
    // destroy so a closed tab doesn't keep a timer (and itself) alive.
    const FAST_INTERVAL_MS = 500
    const SLOW_INTERVAL_MS = 5000
    const FAST_ATTEMPTS = 120  // ~1 minute of eager polling at startup

    let gone = false
    const stop = (): void => { gone = true }
    // `destroy(skipDestroyedEvent)` can complete the subject without emitting,
    // so watch both signals.
    tab.destroyed$.subscribe({ next: stop, complete: stop })

    let attempts = 0
    const tick = (): void => {
      if (gone) return
      if (tab.session) {
        subscribeToSession(tab.session)
        return
      }
      attempts++
      setTimeout(tick, attempts < FAST_ATTEMPTS ? FAST_INTERVAL_MS : SLOW_INTERVAL_MS)
    }
    tick()

    // Focus is precisely when Tabby gets around to attaching a restored tab's
    // session, so take the fast path rather than waiting out the poll interval.
    tab.focused$.subscribe(() => {
      if (tab.session) subscribeToSession(tab.session)
    })

    tab.sessionChanged$.subscribe(s => subscribeToSession(s))
  }
}
