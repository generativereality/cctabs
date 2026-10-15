import { describe, it, expect } from 'bun:test'
import { waitForTabExit } from './tab-exit.js'
import type { TerminalAdapter } from './adapter.js'
import type { Block } from '../types/index.js'

const tab = (id: string): Block => ({ blockid: id, tabid: id, view: 'term' } as Block)
/** An adapter whose tab list follows a script: a list, or 'fail' for a read that threw. */
function scripted(reads: Array<Block[] | 'fail'>): TerminalAdapter {
  let i = 0
  return {
    blocksList: () => {
      const r = reads[Math.min(i++, reads.length - 1)]
      if (r === 'fail') throw new Error('Reading the tab list: the Tabby plugin did not answer')
      return r
    },
  } as unknown as TerminalAdapter
}

describe('waitForTabExit', () => {
  it('never reads a failed tab-list read as "the tab is gone"', async () => {
    // The old silent [] made a timeout look like a closed tab — and profile-copy
    // moves the transcript on the strength of this answer.
    const r = await waitForTabExit(scripted(['fail']), 't1', undefined, 60, 10)
    expect(r).toEqual({ tabGone: false, processGone: false })
  })

  it('keeps waiting through failed reads and sees the close when it comes', async () => {
    const r = await waitForTabExit(scripted(['fail', [tab('t1')], 'fail', []]), 't1', undefined, 1000, 5)
    expect(r).toEqual({ tabGone: true, processGone: true })
  })
})
