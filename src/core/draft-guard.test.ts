import { describe, it, expect } from 'bun:test'
import { waitOutDraft, draftPreview } from './draft-guard.js'
import type { DraftState } from './input-draft.js'

const fake = (states: DraftState[]) => {
  let i = 0
  return { inputDraft: async () => states[Math.min(i++, states.length - 1)] }
}
const noSleep = async () => {}

describe('waitOutDraft', () => {
  it('goes straight through an empty box', async () => {
    const r = await waitOutDraft(fake([{ state: 'empty' }]), 'b', { sleep: noSleep })
    expect(r).toMatchObject({ ok: true, waitedMs: 0 })
  })

  it('does not wait on an unreadable box — that is no evidence of a draft', async () => {
    const r = await waitOutDraft(fake([{ state: 'unknown', why: 'old plugin' }]), 'b', { sleep: noSleep })
    expect(r).toMatchObject({ ok: true, waitedMs: 0 })
  })

  it('waits for a draft to be sent, on a backoff', async () => {
    const slept: number[] = []
    const waiting: string[] = []
    const r = await waitOutDraft(
      fake([{ state: 'draft', text: 'hi' }, { state: 'draft', text: 'hi there' }, { state: 'empty' }]),
      'b',
      { sleep: async (ms) => { slept.push(ms) }, onWaiting: (t) => waiting.push(t) },
    )
    expect(r).toMatchObject({ ok: true, waitedMs: 3000 })
    expect(slept).toEqual([1000, 2000])
    expect(waiting).toEqual(['hi']) // announced once, not per poll
  })

  it('gives up when the draft outlasts the wait, and says what it was', async () => {
    const r = await waitOutDraft(fake([{ state: 'draft', text: 'still typing' }]), 'b', { totalMs: 7000, sleep: noSleep })
    expect(r).toEqual({ ok: false, text: 'still typing', waitedMs: 7000 })
  })

  it('refuses at once with a zero wait', async () => {
    const r = await waitOutDraft(fake([{ state: 'draft', text: 'x' }]), 'b', { totalMs: 0, sleep: noSleep })
    expect(r).toEqual({ ok: false, text: 'x', waitedMs: 0 })
  })

  it('goes through on a backend that cannot read screens', async () => {
    expect(await waitOutDraft({}, 'b', { sleep: noSleep })).toMatchObject({ ok: true })
  })
})

describe('draftPreview', () => {
  it('keeps a draft on one line and short', () => {
    expect(draftPreview('a\nb')).toBe('"a ↵ b"')
    expect(draftPreview('x'.repeat(70)).length).toBeLessThan(70)
  })
})
