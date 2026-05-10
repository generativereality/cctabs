import { Injectable } from '@angular/core'
import { v4 as uuidv4 } from 'uuid'
import { AppService, BaseTabComponent, SplitTabComponent } from 'tabby-core'
import { BaseTerminalTabComponent } from 'tabby-terminal'
import { CctabsLogger } from './logger'

/**
 * Stable UUID per BaseTabComponent. Lives for the tab's lifetime; the same
 * UUID is the public identity surfaced on /api/tabs and used for every other
 * /api/tabs/:uuid/... endpoint.
 *
 * SplitTabComponent flattens to its child terminal tabs — each split pane
 * gets its own UUID so cctabs can address them independently.
 */
@Injectable({ providedIn: 'root' })
export class TabRegistry {
  private byTab = new WeakMap<BaseTabComponent, string>()
  private byUuid = new Map<string, BaseTabComponent>()

  constructor (private app: AppService, private logger: CctabsLogger) {
    for (const tab of app.tabs) {
      this.registerTreeForTab(tab)
    }

    app.tabOpened$.subscribe(tab => this.registerTreeForTab(tab))
    app.tabClosed$.subscribe(tab => this.unregisterTreeForTab(tab))
  }

  list (): BaseTabComponent[] {
    return Array.from(this.byUuid.values())
  }

  uuidOf (tab: BaseTabComponent): string | undefined {
    return this.byTab.get(tab)
  }

  /** Get a tab by its UUID, or undefined if it has been closed. */
  resolve (uuid: string): BaseTabComponent | undefined {
    return this.byUuid.get(uuid)
  }

  /** Iterate over (uuid, tab) pairs, expanding splits to their leaf tabs. */
  entries (): Array<{ uuid: string; tab: BaseTabComponent }> {
    return Array.from(this.byUuid.entries()).map(([uuid, tab]) => ({ uuid, tab }))
  }

  private registerTreeForTab (tab: BaseTabComponent): void {
    this.register(tab)
    if (tab instanceof SplitTabComponent) {
      for (const child of tab.getAllTabs()) {
        if (child instanceof BaseTerminalTabComponent) this.register(child)
      }
    }
  }

  private unregisterTreeForTab (tab: BaseTabComponent): void {
    this.unregister(tab)
    if (tab instanceof SplitTabComponent) {
      for (const child of tab.getAllTabs()) {
        this.unregister(child)
      }
    }
  }

  private register (tab: BaseTabComponent): void {
    if (this.byTab.has(tab)) return
    const uuid = uuidv4()
    this.byTab.set(tab, uuid)
    this.byUuid.set(uuid, tab)
    this.logger.info('tab registered', uuid, tab.title || '(untitled)')
  }

  private unregister (tab: BaseTabComponent): void {
    const uuid = this.byTab.get(tab)
    if (!uuid) return
    this.byTab.delete(tab)
    this.byUuid.delete(uuid)
    this.logger.info('tab unregistered', uuid)
  }
}
