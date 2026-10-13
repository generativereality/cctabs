import { describe, it, expect } from 'bun:test'
import { renameRoute, invalidNameReason, lastCustomTitle } from './rename-plan.js'

describe('renameRoute', () => {
  it('goes through Claude when it is running, even with the transcript in hand', () => {
    // The disk append is what a running Claude overwrites on its next turn.
    expect(renameRoute({ claudeRunning: true, sessionFile: '/x.jsonl', newName: 'pay-bills-3009' }))
      .toEqual({ kind: 'slash', text: '/rename pay-bills-3009' })
  })

  it('goes through Claude when running even if the session is unknown', () => {
    expect(renameRoute({ claudeRunning: true, sessionFile: null, newName: 'n' }).kind).toBe('slash')
  })

  it('appends to disk only when nothing is running to overwrite it', () => {
    expect(renameRoute({ claudeRunning: false, sessionFile: '/x.jsonl', newName: 'n' })).toEqual({ kind: 'disk' })
  })

  it('relabels only the tab when there is no session', () => {
    expect(renameRoute({ claudeRunning: false, sessionFile: null, newName: 'n' })).toEqual({ kind: 'tab-only' })
  })
})

describe('invalidNameReason', () => {
  it('accepts ordinary names, spaces included', () => {
    expect(invalidNameReason('naf-release vault')).toBeNull()
  })
  it('rejects empty and whitespace-only names', () => {
    expect(invalidNameReason('')).not.toBeNull()
    expect(invalidNameReason('  ')).not.toBeNull()
  })
  it('rejects a newline, which would submit /rename early', () => {
    expect(invalidNameReason('a\nb')).not.toBeNull()
    expect(invalidNameReason('a\x1b')).not.toBeNull()
  })
})

describe('lastCustomTitle', () => {
  const id = '77aef65b-10a0-48ac-9625-9a9a169b8155'
  const t = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: id })

  it('reads the last title, not the first', () => {
    // The fleet case: cctabs' write, then the running Claude re-asserting its own.
    const jsonl = [t('pay-bills-2609'), t('pay-bills-3009'), t('pay-bills-2609')].join('\n')
    expect(lastCustomTitle(jsonl)).toBe('pay-bills-2609')
  })
  it('ignores a torn final line and lines that only mention the type', () => {
    const jsonl = [t('a'), JSON.stringify({ type: 'user', message: { content: '"custom-title"' } }), '{"type":"custom-ti'].join('\n')
    expect(lastCustomTitle(jsonl)).toBe('a')
  })
  it('is undefined for a transcript with no title', () => {
    expect(lastCustomTitle('')).toBeUndefined()
  })
})
