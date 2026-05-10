import { Injectable } from '@angular/core'
import { v4 as uuidv4 } from 'uuid'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { CctabsLogger } from './logger'

/**
 * Stable UUID per BaseTabComponent. Same UUID is the public identity on
 * /api/tabs and every /api/tabs/:uuid/... endpoint.
 *
 * Split children aren't surfaced via app.tabOpened$, so we walk the tree
 * fresh on every `entries()` call and lazy-assign UUIDs along the way. The
 * WeakMap keeps UUIDs stable across calls; closed tabs drop out via the
 * `tabClosed$` subscription.
 */
@Injectable({ providedIn: 'root' })
export class TabRegistry {
  private byTab = new WeakMap<BaseTabComponent, string>()
  private byUuid = new Map<string, BaseTabComponent>()

  constructor (private app: AppService, private logger: CctabsLogger) {
    app.tabClosed$.subscribe(tab => this.unregisterTreeForTab(tab))
  }

  uuidOf (tab: BaseTabComponent): string | undefined {
    return this.byTab.get(tab)
  }

  /** Get a tab by its UUID, or undefined if it has been closed. */
  resolve (uuid: string): BaseTabComponent | undefined {
    return this.byUuid.get(uuid)
  }

  /**
   * Walk all live tabs (top-level + every split descendant) right now,
   * assigning UUIDs as we go. Returns one entry per leaf tab.
   *
   * The split *wrapper* is not surfaced — only its terminal-bearing leaves.
   * Top-level non-split tabs are surfaced as themselves.
   */
  entries (): Array<{ uuid: string; tab: BaseTabComponent }> {
    const out: Array<{ uuid: string; tab: BaseTabComponent }> = []
    const seen = new Set<BaseTabComponent>()

    const visit = (tab: BaseTabComponent): void => {
      if (seen.has(tab)) return
      seen.add(tab)
      if (tab instanceof SplitTabComponent) {
        for (const child of tab.getAllTabs()) visit(child)
        return
      }
      out.push({ uuid: this.ensureUuid(tab), tab })
    }

    for (const top of this.app.tabs) visit(top)
    return out
  }

  private ensureUuid (tab: BaseTabComponent): string {
    let uuid = this.byTab.get(tab)
    if (uuid) return uuid
    uuid = uuidv4()
    this.byTab.set(tab, uuid)
    this.byUuid.set(uuid, tab)
    this.logger.info('tab registered', uuid, tab.title || '(untitled)')
    return uuid
  }

  private unregisterTreeForTab (tab: BaseTabComponent): void {
    this.unregister(tab)
    if (tab instanceof SplitTabComponent) {
      for (const child of tab.getAllTabs()) this.unregister(child)
    }
  }

  private unregister (tab: BaseTabComponent): void {
    const uuid = this.byTab.get(tab)
    if (!uuid) return
    this.byTab.delete(tab)
    this.byUuid.delete(uuid)
    this.logger.info('tab unregistered', uuid)
  }
}
