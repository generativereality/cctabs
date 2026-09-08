import { describe, it, expect } from 'bun:test'
import {
  countPayloadLines,
  judgeDelivery,
  judgePaste,
  readPasteEvidence,
} from './paste-confirm.js'

describe('countPayloadLines', () => {
  it('counts line breaks, in either newline form', () => {
    expect(countPayloadLines('a\nb\nc')).toBe(2)
    expect(countPayloadLines('a\rb\rc')).toBe(2)
    expect(countPayloadLines('single line')).toBe(0)
    expect(countPayloadLines('')).toBe(0)
  })
})

describe('readPasteEvidence', () => {
  it('reads the chip line count', () => {
    const e = readPasteEvidence('[Pasted text #1 +117 lines]', 'nothing')
    expect(e.chipSeen).toBe(true)
    expect(e.chipLines).toBe(117)
  })

  // Tabby's buffer endpoint drops spaces between glyphs unpredictably, which is
  // why everything here matches on a whitespace-stripped copy.
  it('reads a chip whose spaces the buffer dropped', () => {
    expect(readPasteEvidence('[Pastedtext#2+45lines]', 'x').chipLines).toBe(45)
  })

  it('reads a chip with no paste number, and the singular "1 line"', () => {
    expect(readPasteEvidence('[Pasted text +9 lines]', 'x').chipLines).toBe(9)
    expect(readPasteEvidence('[Pasted text #1 +1 line]', 'x').chipLines).toBe(1)
  })

  it('notices a chip it cannot get a count out of', () => {
    const e = readPasteEvidence('[Pasted text #1]', 'x')
    expect(e.chipSeen).toBe(true)
    expect(e.chipLines).toBeUndefined()
  })

  it('finds the sentinel across dropped whitespace', () => {
    expect(readPasteEvidence('he llo fr om tab', 'hellofrom').sentinelSeen).toBe(true)
  })

  it('reports nothing for an empty buffer, and never sees an empty sentinel', () => {
    expect(readPasteEvidence('', 'hellofrom').sentinelSeen).toBe(false)
    expect(readPasteEvidence('anything at all', '').sentinelSeen).toBe(false)
  })
})

describe('judgePaste', () => {
  it('confirms an echoed paste on the strength of its visible front', () => {
    const v = judgePaste({ sentinelSeen: true, chipSeen: false }, 0)
    expect(v).toMatchObject({ landed: true, confirmed: true })
  })

  // The correction that cost a measurement to find: a 6,892-byte, 76-line
  // payload delivered COMPLETELY into an idle tab while its chip read
  // "+10 lines". The chip's count does not track the payload, so a shortfall
  // is not evidence of truncation and must not fail the send.
  it('treats a collapsed chip as landed but NOT confirmed, whatever it counts', () => {
    for (const chipLines of [10, 60, 119, undefined]) {
      const v = judgePaste({ sentinelSeen: false, chipSeen: true, chipLines }, 120)
      expect(v.landed).toBe(true)
      expect(v.confirmed).toBe(false)
    }
  })

  it('names the two ways to actually establish completeness', () => {
    const v = judgePaste({ sentinelSeen: false, chipSeen: true, chipLines: 10 }, 120)
    expect(v.detail).toContain('--verify')
    expect(v.detail).toContain('--path')
  })

  it('rejects a buffer showing no sign of the text at all', () => {
    const v = judgePaste({ sentinelSeen: false, chipSeen: false }, 40)
    expect(v.landed).toBe(false)
    expect(v.confirmed).toBe(false)
  })
})

describe('judgeDelivery', () => {
  const payload = 'FRONT-MARKER: alpha-7391\nfiller filler filler filler filler\nEND-MARKER: omega-5520 do the thing now'

  it('confirms a payload whose front and tail both reached the session', () => {
    // Claude appends its own context to the recorded message, so the received
    // text is a superset — hence containment rather than equality.
    const received = `${payload}\n<system-reminder>some appended context</system-reminder>`
    const v = judgeDelivery(payload, received)
    expect(v.delivered).toBe(true)
  })

  // Whitespace differs on every hop: send converts LF to CR, the transcript
  // stores LF, and the terminal may re-wrap. None of that is a failure.
  it('ignores whitespace differences between what was sent and what was stored', () => {
    const received = payload.replace(/\n/g, '\r\n  ')
    expect(judgeDelivery(payload, received).delivered).toBe(true)
  })

  // The observed clipping mode, and the reason each end is named separately.
  it('identifies a front-clipped delivery as such', () => {
    // The tail arrives, the front does not — the received text must be long
    // enough to hold the tail fingerprint, as a real clipped payload is.
    const v = judgeDelivery(payload, payload.slice(-60))
    expect(v.delivered).toBe(false)
    expect(v.detail).toContain('END of the payload but not its FRONT')
  })

  it('identifies a delivery cut short at the end', () => {
    const v = judgeDelivery(payload, payload.slice(0, 60))
    expect(v.delivered).toBe(false)
    expect(v.detail).toContain('FRONT of the payload but not its end')
  })

  it('reports an unrelated message as matching neither end', () => {
    const v = judgeDelivery(payload, 'something else entirely')
    expect(v.delivered).toBe(false)
    expect(v.detail).toContain('neither end')
  })

  // "I could not check" must never read as "it arrived".
  it('reports nothing recorded as a failed verification, not a pass', () => {
    const v = judgeDelivery(payload, null)
    expect(v.delivered).toBe(false)
    expect(v.detail).toContain('has not recorded any message')
  })
})
