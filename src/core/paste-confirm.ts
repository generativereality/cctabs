/**
 * Deciding whether a pasted payload landed in a tab's input box — and being
 * honest about the limits of what the screen can tell us.
 *
 * The history here is worth keeping, because both of the obvious answers are
 * wrong and one of them was measured wrong twice:
 *
 *   1. "A paste chip is on screen, so it arrived." Claude Code collapses any
 *      sizeable paste into `[Pasted text #1 +117 lines]`, and that chip renders
 *      whether the whole payload arrived or a fraction did. A 6,835-byte brief
 *      once landed as its last 756 bytes with both ends reporting success.
 *   2. "So compare the chip's line count against what was sent." Also wrong,
 *      and measured: a 6,892-byte, 76-line payload delivered *completely* into
 *      an idle tab — front marker, tail marker and all, confirmed by reading
 *      what the receiving session recorded — while the chip on screen read
 *      `+10 lines`. The chip's count is not a count of the payload. Treating a
 *      shortfall as truncation fails healthy sends.
 *
 * What is left is a real and useful conclusion: for a collapsed paste the
 * screen **cannot** establish completeness. So this module distinguishes
 * "something arrived" from "all of it arrived, verified", refuses to claim the
 * second when it can only see the first, and leaves the actual comparison to
 * the transcript (see `judgeDelivery`), which records what the session received.
 */

/** What the tab's buffer shows about the paste we just sent. */
export interface PasteEvidence {
  /** The front of the payload is visible in the buffer (a small, echoed paste). */
  sentinelSeen: boolean
  /** A paste chip is on screen. */
  chipSeen: boolean
  /**
   * The line count the newest chip reports, when it reports one.
   *
   * Informational only — reported in messages, never used to decide the
   * verdict. See the note above: it does not track the payload.
   */
  chipLines?: number
}

export interface PasteVerdict {
  /** Something from the payload reached the tab. */
  landed: boolean
  /** We could establish that ALL of it reached the tab. */
  confirmed: boolean
  /** Operator-facing explanation of the call, used verbatim in send's output. */
  detail: string
}

/** Line breaks in a payload. Reported for context, not used as a threshold. */
export function countPayloadLines(text: string): number {
  const matches = text.match(/[\r\n]/g)
  return matches ? matches.length : 0
}

const CHIP_WITH_COUNT = /\[Pastedtext#?\d*\+(\d+)lines?\]/g

/**
 * Read the buffer for signs of the paste.
 *
 * Everything is matched against a whitespace-stripped copy: Tabby's buffer
 * endpoint drops spaces between glyphs unpredictably, so `[Pasted text #1 +117
 * lines]` can arrive with any subset of its spaces missing. The `sentinel` must
 * already be whitespace-stripped by the caller for the same reason.
 */
export function readPasteEvidence(buffer: string, sentinel: string): PasteEvidence {
  const stripped = buffer.replace(/\s+/g, '')

  let chipLines: number | undefined
  CHIP_WITH_COUNT.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = CHIP_WITH_COUNT.exec(stripped)) !== null) chipLines = Number(m[1])

  return {
    sentinelSeen: sentinel.length > 0 && stripped.includes(sentinel),
    chipSeen: stripped.includes('[Pastedtext'),
    chipLines,
  }
}

/**
 * Turn the evidence into a verdict.
 *
 * The echoed case is the only one the screen can actually confirm: the front of
 * the text is visible, so it is there. A collapsed chip is `landed` but never
 * `confirmed`, and that gap is deliberate — it is what stops `send` printing a
 * ✔ over a delivery it did not check, without inventing a failure it cannot
 * substantiate either.
 */
export function judgePaste(e: PasteEvidence, expectedLines: number): PasteVerdict {
  if (e.sentinelSeen) {
    return { landed: true, confirmed: true, detail: 'the text is visible in the tab' }
  }

  if (e.chipSeen) {
    const chip = e.chipLines !== undefined ? ` (its chip reads +${e.chipLines} lines` : ' (chip present'
    return {
      landed: true,
      confirmed: false,
      detail:
        `the paste collapsed to a chip${chip}, which does not track the ~${expectedLines}-line payload) — ` +
        `the screen cannot show how much of it arrived, so completeness is unverified. ` +
        `Use --verify to check what the session actually received, or --path to avoid the prompt line entirely`,
    }
  }

  return { landed: false, confirmed: false, detail: 'nothing from the text appeared in the tab' }
}

/** What the receiving session recorded, compared against what was sent. */
export interface DeliveryVerdict {
  delivered: boolean
  detail: string
}

/**
 * Compare a payload against the messages the target session actually received.
 *
 * This is the only trustworthy answer to "did all of it arrive?", and it is
 * available because Claude writes the user messages it received to its
 * transcript. Both sides are whitespace-stripped before comparing: `send`
 * converts newlines to CR on the way out, the transcript stores LF, and the
 * terminal is free to re-wrap in between — none of which is a delivery failure.
 *
 * ALL the session's messages are searched, not just its newest, and that is a
 * fix rather than thoroughness: checking only the newest one raced against the
 * session's own work. A `--path` handoff tells the tab to read a file, so by the
 * time the check ran the newest user-role entry was the file it had read, and
 * the payload was reported as matching neither end of itself.
 *
 * The front and the tail are checked separately and named separately, because
 * which end is missing is the diagnostic: a missing front is the observed
 * clipping mode, while a missing tail would be something else entirely.
 */
export function judgeDelivery(payload: string, received: readonly string[] | null): DeliveryVerdict {
  if (!received || received.length === 0) {
    return {
      delivered: false,
      detail: 'the target session has not recorded any message matching this send — it may not have been submitted, or the session may not have started its turn yet',
    }
  }

  const strip = (s: string) => s.replace(/\s+/g, '')
  const want = strip(payload)
  const FINGERPRINT = 40
  const front = want.slice(0, FINGERPRINT)
  const tail = want.slice(-FINGERPRINT)

  let sawFront = false
  let sawTail = false
  for (const message of received) {
    const got = strip(message)
    const frontOk = got.includes(front)
    const tailOk = got.includes(tail)
    if (frontOk && tailOk) {
      return {
        delivered: true,
        detail: `the session received the whole payload (front and tail both present in its transcript, ${want.length} non-whitespace chars sent)`,
      }
    }
    sawFront = sawFront || frontOk
    sawTail = sawTail || tailOk
  }

  if (!sawFront && sawTail) {
    return {
      delivered: false,
      detail: 'the session received the END of the payload but not its FRONT — this is the front-clipping failure mode; re-send with --path',
    }
  }
  if (sawFront && !sawTail) {
    return {
      delivered: false,
      detail: 'the session received the FRONT of the payload but not its end — it was cut short; re-send with --path',
    }
  }
  return {
    delivered: false,
    detail: `none of the ${received.length} message(s) the session recorded matches either end of what was sent`,
  }
}
