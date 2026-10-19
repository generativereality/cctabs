import type { TerminalAdapter } from './adapter.js'
import { draftBackoff, type DraftState } from './input-draft.js'

/** Default time to wait for a draft to clear before giving up, in seconds. */
export const DRAFT_WAIT_SECONDS = 60

export type DraftGuardResult =
  /** Clear to type. `state` says what that was decided on. */
  | { ok: true; state: DraftState; waitedMs: number }
  /** A draft was still there when the wait ran out. Nothing was typed. */
  | { ok: false; text: string; waitedMs: number }

/**
 * Don't type into someone's unsent draft. Waits for the input box to clear,
 * re-reading it on an exponential backoff (1s, 2s, 4s … capped at 16s), and
 * gives up after `totalMs`.
 *
 * A box that can't be read (`unknown`) is NOT waited on: that is an older
 * plugin, a tab never shown, or no Claude input box at all — a shell, or a
 * picker waiting for the digit being sent. Blocking those would break the
 * replies `send` exists for, and the old behaviour is what they had anyway.
 */
export async function waitOutDraft(
  adapter: Pick<TerminalAdapter, 'inputDraft'>,
  blockId: string,
  opts: {
    totalMs?: number
    sleep?: (ms: number) => Promise<void>
    /** Called once, when the first read finds a draft. */
    onWaiting?: (text: string, totalMs: number) => void
  } = {},
): Promise<DraftGuardResult> {
  const totalMs = opts.totalMs ?? DRAFT_WAIT_SECONDS * 1000
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (!adapter.inputDraft) return { ok: true, state: { state: 'unknown', why: 'backend cannot read the screen' }, waitedMs: 0 }

  let state = await adapter.inputDraft(blockId)
  if (state.state !== 'draft') return { ok: true, state, waitedMs: 0 }
  opts.onWaiting?.(state.text, totalMs)

  let waited = 0
  for (const step of draftBackoff(totalMs)) {
    await sleep(step)
    waited += step
    state = await adapter.inputDraft(blockId)
    if (state.state !== 'draft') return { ok: true, state, waitedMs: waited }
  }
  return { ok: false, text: state.text, waitedMs: waited }
}

/** One-line preview of a draft for a message. */
export function draftPreview(text: string, max = 60): string {
  const one = text.replace(/\s*\n\s*/g, ' ↵ ')
  return JSON.stringify(one.length > max ? one.slice(0, max) + '…' : one)
}

export type SubmitResult =
  /** The box emptied after Enter (`checked`), or could not be read to tell. */
  | { submitted: true; checked: boolean; enters: number }
  /** Every Enter left the text sitting in the box. */
  | { submitted: false; text: string; enters: number }

/**
 * Press Enter, and check that it SUBMITTED: that the input box emptied.
 *
 * `send` used to press Enter once and report ✔ on the strength of the text
 * having landed. An Enter can be swallowed — mmm-dev's message to clerk-dev
 * (2026-10-17, ~800 bytes, sent 6s after clerk-dev ended a turn) printed
 * `✔ Sent` and then sat unsubmitted in clerk-dev's box for hours, where every
 * later send read it as someone's draft and refused. A submit empties the box
 * whether the tab is idle or busy (a busy Claude queues the message), so text
 * still in the box after Enter means the Enter did not take: press it again,
 * a few times, then report failure rather than success.
 *
 * Re-pressing is safe: once the box is empty an Enter does nothing. A box
 * that can't be read (`unknown`, or no screen) is taken as submitted, but
 * reported as unchecked.
 */
export async function submitAndConfirm(
  adapter: Pick<TerminalAdapter, 'inputDraft' | 'sendInput'>,
  blockId: string,
  opts: { sleep?: (ms: number) => Promise<void>; enters?: number; polls?: number; pollMs?: number } = {},
): Promise<SubmitResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const maxEnters = opts.enters ?? 4
  const polls = opts.polls ?? 4
  const pollMs = opts.pollMs ?? 400

  let text = ''
  for (let enters = 1; enters <= maxEnters; enters++) {
    await adapter.sendInput(blockId, '\r')
    if (!adapter.inputDraft) return { submitted: true, checked: false, enters }
    for (let i = 0; i < polls; i++) {
      await sleep(pollMs)
      const state = await adapter.inputDraft(blockId)
      if (state.state === 'empty') return { submitted: true, checked: true, enters }
      if (state.state === 'unknown') return { submitted: true, checked: false, enters }
      text = state.text
    }
  }
  return { submitted: false, text, enters: maxEnters }
}

/**
 * Take back text this send typed and could not submit, so it does not sit in
 * the box looking like someone's draft — which blocks every later send to the
 * tab. Only for a box that was EMPTY before the send typed: then everything
 * in it is ours. Returns whether the box is empty again.
 */
export async function clearOwnText(
  adapter: Pick<TerminalAdapter, 'inputDraft' | 'sendInput'>,
  blockId: string,
  opts: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<boolean> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  if (!adapter.inputDraft) return false
  // Ctrl-U clears to the start of the line; a multi-line draft takes several.
  for (let i = 0; i < 6; i++) {
    await adapter.sendInput(blockId, '\x15')
    await sleep(250)
    if ((await adapter.inputDraft(blockId)).state === 'empty') return true
  }
  return false
}
