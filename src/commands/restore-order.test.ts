import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { TerminalAdapter } from '../core/adapter.js'
import type { AllData, Block } from '../types/index.js'
import { runRestore, RESTORE_TIMING } from './restore.js'

/**
 * A whole manifest restore, run against a fake terminal, checked for the one
 * thing a unit test of the order helper can't see: what the bar looks like
 * afterwards. The fake reorders the way the Tabby plugin does — listed tabs
 * first, in the listed order, then every unlisted tab in its existing order —
 * which is precisely the behaviour that turned the old manifest-only order
 * into "this run's batch goes to the front".
 */
class FakeBar {
  order: string[] = []
  names = new Map<string, string>()
  private n = 0

  constructor(initial: string[]) {
    for (const name of initial) this.add(name)
  }

  add(name: string): string {
    const id = `tab-${++this.n}-${name}`
    this.order.push(id)
    this.names.set(id, name)
    return id
  }

  get bar(): string[] {
    return this.order.map((id) => this.names.get(id)!)
  }

  adapter(current: string): TerminalAdapter {
    const block = (id: string): Block => ({ blockid: id, tabid: id, view: 'term', shellPid: process.pid })
    const currentId = this.order.find((id) => this.names.get(id) === current)!
    return {
      getAllData: async (): Promise<AllData> => ({
        blocks: this.order.map(block),
        tabsById: new Map(this.order.map((id) => [id, [block(id)]])),
        tabNames: new Map(this.names),
        workspaces: [{ windowid: 'w', workspacedata: { oid: 'ws', name: 'ws', tabids: [...this.order] } }],
      }) as unknown as AllData,
      closeSocket: () => {},
      blocksList: () => this.order.map(block),
      scrollback: () => '',
      confirmScrollbackEmpty: async () => false,
      detectSessionStatus: () => 'idle',
      deleteBlock: () => {},
      newTab: async () => false,
      waitForNewBlock: async () => null,
      renameTab: async () => {},
      sendInput: async () => {},
      backendCapabilities: async () => ['spawn-waits-for-pty'],
      reorderTabs: async (listed: string[]) => {
        const known = listed.filter((id) => this.order.includes(id))
        this.order = [...known, ...this.order.filter((id) => !known.includes(id))]
      },
      resolveTab: (query, byId, names) => [...byId.keys()].filter((id) => names.get(id) === query),
      resolveBlock: () => [],
      resolveWorkspace: () => [],
      currentTabId: () => currentId,
      currentBlockId: () => currentId,
      currentWorkspaceId: () => 'ws',
    } as TerminalAdapter
  }
}

describe('restore --manifest leaves the bar in a sane order', () => {
  let dir: string
  const saved = { ...RESTORE_TIMING }

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctabs-order-'))
    // Verification is not what is under test; don't sleep through it.
    Object.assign(RESTORE_TIMING, { verifySettleMs: 0, verifyDeadlineMs: 0, verifyPollMs: 0, attachSettleMs: 0 })
  })
  afterAll(() => {
    Object.assign(RESTORE_TIMING, saved)
    rmSync(dir, { recursive: true, force: true })
  })

  const entries = (names: string[]) => names.map((name) => ({ name, dir }))

  it('keeps the invoking tab first and appends each run after the last', async () => {
    // The measured sequence: only the coordinating tab open, then two restore
    // runs. Before the fix the second batch came back at the very front.
    const term = new FakeBar(['coord'])
    const spawn = async (o: { tabName: string }) => term.add(o.tabName)

    await runRestore({ manifest: entries(['a1', 'a2']), scopedDir: null, createMissing: true, dryRun: true }, term.adapter('coord'), spawn as never)
    expect(term.bar).toEqual(['coord']) // a dry run creates nothing

    await runRestore({ manifest: entries(['a1', 'a2']), scopedDir: null, createMissing: true, dryRun: false }, term.adapter('coord'), spawn as never)
    expect(term.bar).toEqual(['coord', 'a1', 'a2'])

    await runRestore({ manifest: entries(['b1', 'b2']), scopedDir: null, createMissing: true, dryRun: false }, term.adapter('coord'), spawn as never)
    expect(term.bar).toEqual(['coord', 'a1', 'a2', 'b1', 'b2'])
  })

  it('does not move tabs the restore did not create', async () => {
    const term = new FakeBar(['x', 'coord', 'y'])
    const spawn = async (o: { tabName: string }) => term.add(o.tabName)
    // 'y' already exists and is running; 'n' is new.
    await runRestore({ manifest: entries(['n', 'y']), scopedDir: null, createMissing: true, dryRun: false }, term.adapter('coord'), spawn as never)
    expect(term.bar).toEqual(['x', 'coord', 'y', 'n'])
  })
})
