import { describe, it, expect } from 'bun:test'
import { waitOutDraft, draftPreview, submitAndConfirm, clearOwnText } from './draft-guard.js'
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

  it('treats a box holding only a prompt suggestion as empty: no wait, no draft warning', async () => {
    let warned = false
    const r = await waitOutDraft(fake([{ state: 'empty', suggestion: 'ok run the tests' }]), 'b', {
      sleep: noSleep,
      onWaiting: () => { warned = true },
    })
    expect(r).toMatchObject({ ok: true, waitedMs: 0, state: { state: 'empty' } })
    expect(warned).toBe(false)
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

/** A fake tab: a scripted input box, recording what was typed. */
const tab = (states: DraftState[]) => {
  let i = 0
  const sent: string[] = []
  return {
    sent,
    sendInput: async (_b: string, t: string) => { sent.push(t) },
    inputDraft: async () => states[Math.min(i++, states.length - 1)],
  }
}

describe('submitAndConfirm', () => {
  it('one Enter that empties the box is a checked submit', async () => {
    const t = tab([{ state: 'empty' }])
    expect(await submitAndConfirm(t, 'b', { sleep: noSleep })).toEqual({ submitted: true, checked: true, enters: 1 })
    expect(t.sent).toEqual(['\r'])
  })

  // THE BUG: mmm-dev → clerk-dev, 2026-10-17. Text landed, the Enter was
  // swallowed, and send printed ✔. Now a box still holding the text after
  // Enter gets another Enter.
  it('presses Enter again when the first one was swallowed', async () => {
    const msg: DraftState = { state: 'draft', text: 'From mmm-dev: go ahead' }
    const t = tab([msg, msg, msg, msg, { state: 'empty' }])
    expect(await submitAndConfirm(t, 'b', { sleep: noSleep, polls: 4 })).toEqual({ submitted: true, checked: true, enters: 2 })
    expect(t.sent).toEqual(['\r', '\r'])
  })

  it('reports failure, not success, when no Enter takes', async () => {
    const t = tab([{ state: 'draft', text: 'stuck' }])
    expect(await submitAndConfirm(t, 'b', { sleep: noSleep, enters: 3 })).toEqual({ submitted: false, text: 'stuck', enters: 3 })
    expect(t.sent).toEqual(['\r', '\r', '\r'])
  })

  it('an unreadable box is a submit it cannot check, not a failure', async () => {
    expect(await submitAndConfirm(tab([{ state: 'unknown', why: 'picker' }]), 'b', { sleep: noSleep }))
      .toEqual({ submitted: true, checked: false, enters: 1 })
    const sent: string[] = []
    expect(await submitAndConfirm({ sendInput: async (_b, x) => { sent.push(x) } }, 'b', { sleep: noSleep }))
      .toEqual({ submitted: true, checked: false, enters: 1 })
  })
})

describe('clearOwnText', () => {
  it('clears until the box is empty', async () => {
    const t = tab([{ state: 'draft', text: 'line 2' }, { state: 'empty' }])
    expect(await clearOwnText(t, 'b', { sleep: noSleep })).toBe(true)
    expect(t.sent).toEqual(['\x15', '\x15'])
  })

  it('says so when it cannot', async () => {
    expect(await clearOwnText(tab([{ state: 'draft', text: 'x' }]), 'b', { sleep: noSleep })).toBe(false)
    expect(await clearOwnText({ sendInput: async () => {} }, 'b', { sleep: noSleep })).toBe(false)
  })
})
