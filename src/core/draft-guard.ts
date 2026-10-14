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
