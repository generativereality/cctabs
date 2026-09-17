import { define } from 'gunshi'
import { consola } from 'consola'
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { requireAdapter } from '../core/adapter.js'
import { sendTextWithConfirmation } from '../core/open-session.js'
import { resolveTabTarget } from '../core/tab-target.js'
import { classifyTerminalBuffer, promptIsReady } from '../core/session-status.js'
import { judgeDelivery } from '../core/paste-confirm.js'
import { resetTitleIndexCache, resolveTabSession } from '../core/session.js'
import { locateTranscriptFile, readUserMessages } from '../core/transcript.js'
import { parseSendArgv } from '../core/send-argv.js'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

/**
 * Payload size above which sending into a busy tab is refused outright.
 *
 * Short replies are the whole point of sending into an active tab — `yes` to a
 * tool call, `2` to a picker — and refusing those would break the flow this
 * command exists for. A multi-kilobyte brief is a different act, and pushing
 * one into a tab mid-turn is what produced the measured clipping. So the guard
 * is on size, not merely on busyness.
 */
export const CLIP_RISK_BYTES = 1024

/**
 * The message that hands a tab a file to read instead of pasting its contents.
 *
 * This is the only send shape with no truncation surface at all: what crosses
 * the prompt line is a path of a hundred-odd bytes, and the payload is read
 * from disk by the receiving session. It became the operator's standing
 * practice for briefs after a 6,835-byte paste arrived as 756 bytes, and it is
 * first-class here for that reason rather than as a convenience.
 *
 * One consequence worth knowing, because it reads like a bug: the receiving
 * session obeys this by *reading the file*, so the file's contents land in its
 * transcript as a tool result. Seeing the contents there means the handoff
 * worked — it does not mean they were pasted.
 */
export function buildPathHandoff(absPath: string): string {
  return `Read the file at ${absPath} in full, and treat its entire contents as the message intended for you — it is your instructions, not a document to summarise.`
}

/** Report a usage failure and exit, before any terminal has been touched. */
function adapterlessExit(message: string): never {
  consola.error(message)
  process.exit(1)
}

export const sendCommand = define({
  name: 'send',
  description: 'Send input to a tab or block (text arg, --file, --path, or stdin pipe)',
  args: {
    target: { type: 'positional', description: 'Tab name, tab ID prefix, or block ID prefix' },
    file: { type: 'string', short: 'f', description: 'Read the text to send from a file' },
    path: { type: 'string', short: 'p', description: "Hand the tab this file PATH and let the receiving session read it, instead of pasting the contents. The robust way to deliver anything large: only the path crosses the prompt line, so there is no truncation surface. Note the receiving session then READS the file, so its transcript will contain the contents as a tool result — that is the handoff working, not a paste." },
    submit: { type: 'boolean', description: 'Send Enter only, submitting whatever is already parked in the tab\'s input box. Explicit alternative to guessing at an empty send.' },
    enter: { type: 'boolean', short: 'e', description: 'Append newline after text (default: true)' },
    force: { type: 'boolean', description: `Send even when the target has a turn in flight. Without this, payloads over ${CLIP_RISK_BYTES} bytes are refused for a busy tab, because that is when text gets silently clipped.` },
    'no-confirm': { type: 'boolean', description: 'Skip the did-it-land check and report only that the bytes were handed over. Faster, and honest about knowing less.' },
    verify: { type: 'boolean', description: "After submitting, read the target session's own transcript and check that what it RECEIVED matches what was sent, front and tail. The only reliable completeness check: a collapsed paste chip cannot be read for it. Fails loudly on a mismatch." },
    'verify-timeout': { type: 'number', description: 'Seconds to wait for the target to record the message when using --verify (default: 30)' },
    'wait-for-prompt': { type: 'boolean', short: 'w', description: 'Poll the buffer until a ready prompt is visible before sending — a shell prompt ($, %, >) or a ready Claude TUI (❯ input line / "auto mode" footer). Useful for freshly-spawned tabs.' },
    'wait-timeout': { type: 'number', description: 'Timeout in seconds for --wait-for-prompt (default: 10)' },
  },
  async run(ctx) {
    // Positionals come from the RAW command line, not from the option parser.
    // The parser drops any argv element containing `--`, which silently ate the
    // payload of any message that quoted a flag name and left `send` reporting
    // success for a delivery of nothing. See core/send-argv.ts.
    const rawArgv = process.argv.slice(2)
    const cliArgs = parseSendArgv(rawArgv[0] === 'send' ? rawArgv.slice(1) : rawArgv)
    const query = cliArgs.target
    const inlineText = cliArgs.text
    const filePath = ctx.values.file as string | undefined
    const handoffPath = ctx.values.path as string | undefined
    const submitOnly = (ctx.values.submit as boolean | undefined) ?? false
    const appendEnter = (ctx.values.enter as boolean | undefined) ?? true
    const force = (ctx.values.force as boolean | undefined) ?? false
    const skipConfirm = (ctx.values['no-confirm'] as boolean | undefined) ?? false
    const verify = (ctx.values.verify as boolean | undefined) ?? false
    const verifyTimeoutSec = (ctx.values['verify-timeout'] as number | undefined) ?? 30
    const waitForPrompt = (ctx.values['wait-for-prompt'] as boolean | undefined) ?? false
    const waitTimeoutSec = (ctx.values['wait-timeout'] as number | undefined) ?? 10

    if (!query) { consola.error('Usage: cctabs send <tab-or-block> [text]'); process.exit(1) }

    // Reject contradictory sources up front rather than silently preferring
    // one: "I passed --path and it sent the file contents" is the kind of
    // surprise this command can't afford any more of.
    const sources = [
      inlineText !== undefined && 'inline text',
      filePath !== undefined && '--file',
      handoffPath !== undefined && '--path',
      submitOnly && '--submit',
    ].filter(Boolean) as string[]
    if (sources.length > 1) {
      consola.error(`Pick one text source — ${sources.join(', ')} were all given.`)
      process.exit(1)
    }

    // Resolve text source: --submit > inline arg > --path > --file > stdin
    let rawText: string
    if (submitOnly) {
      rawText = ''
    } else if (inlineText !== undefined) {
      rawText = inlineText.replace(/\\n/g, '\r').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    } else if (handoffPath !== undefined) {
      const abs = resolve(handoffPath)
      if (!existsSync(abs)) {
        consola.error(`--path ${abs} does not exist. The receiving session would be sent a path to nothing.`)
        process.exit(1)
      }
      rawText = buildPathHandoff(abs)
    } else if (filePath) {
      rawText = readFileSync(filePath, 'utf-8').replace(/\n/g, '\r')
    } else {
      rawText = (await readStdin()).replace(/\n/g, '\r')
    }

    // The submit Enter is sent as its OWN event, separate from the body (see
    // the send below). So strip any trailing CR off the body here and track
    // whether to fire an Enter afterwards.
    let sendEnter = appendEnter
    if (rawText.endsWith('\r')) { rawText = rawText.replace(/\r+$/, ''); sendEnter = true }
    if (submitOnly) sendEnter = true

    // An empty body that nobody asked for is a FAILURE, not a warning.
    //
    // This is the tell the operator spotted: `✔ Sent to 5f3e853e: ⏎` with an
    // empty preview, for a ~900-byte report that arrived nowhere. Pressing
    // Enter and reporting success is the worst possible response to "I ended up
    // with no payload" — it looks like a delivery. An explicit empty is still
    // honoured: `--submit`, or a literal `""` argument, both mean "just submit".
    const explicitlyEmpty = submitOnly || inlineText === '' || cliArgs.explicitText
    if (!explicitlyEmpty && rawText.length === 0) {
      adapterlessExit(
        filePath
          ? `${filePath} is empty, so there is nothing to send. Pass --submit if you meant to press Enter on a prompt already in the box.`
          : handoffPath !== undefined
            ? `${handoffPath} produced no message to send.`
            : inlineText === undefined
              ? `No text to send: no inline argument, no --file, no --path, and stdin was empty. If your text contains \`--\`, put it after a \`--\` terminator: cctabs send ${query ?? '<tab>'} -- <your text>`
              : 'Nothing to send.',
      )
    }

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()

    const resolved = resolveTabTarget(adapter, query, tabsById, tabNames)
    if (!resolved.ok) {
      adapter.closeSocket()
      consola.error(resolved.message)
      for (const line of resolved.lines ?? []) consola.log(line)
      process.exit(1)
    }
    const { blockId, name: tabName, cwd: tabCwd } = resolved.target

    if (verify && (!tabName || !tabCwd)) {
      adapter.closeSocket()
      consola.error('--verify needs a named tab: it reads the target session\'s transcript, and a bare block has no session to read.')
      process.exit(1)
    }

    if (waitForPrompt) {
      const deadline = Date.now() + waitTimeoutSec * 1000
      let ready = false
      while (Date.now() < deadline) {
        // 20 rows, not 8: Claude renders notices (`Restart to update`) BELOW
        // the input line, and a short window plus a last-line-only test is
        // what made this time out against tabs that were ready.
        if (promptIsReady(adapter.scrollback(blockId, 20))) { ready = true; break }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!ready) {
        adapter.closeSocket()
        consola.error(`Timed out after ${waitTimeoutSec}s waiting for a ready prompt in ${blockId.slice(0, 8)}`)
        process.exit(1)
      }
    }

    // Refuse to push a large payload into a tab with a turn in flight. This is
    // one of the two ways a send gets clipped, and unlike the other it is
    // knowable beforehand.
    if (!force && rawText.length > 0) {
      const status = classifyTerminalBuffer(adapter.scrollback(blockId, 200))
      if (status === 'active') {
        if (rawText.length > CLIP_RISK_BYTES) {
          adapter.closeSocket()
          consola.error(
            `${blockId.slice(0, 8)} has a turn in flight, and ${rawText.length} bytes sent into a busy input handler is how text gets silently clipped. ` +
            `Wait for it to finish, hand it a file with \`--path\` (no truncation surface), or pass --force if you accept the risk.`,
          )
          process.exit(1)
        }
        consola.warn(`${blockId.slice(0, 8)} has a turn in flight — sending anyway, as this is short enough to be a reply rather than a brief.`)
      }
    }

    // Send the body — confirming it actually landed and re-sending if not, since
    // text sent into a not-yet-ready input handler can be silently lost, front
    // first, or arrive as a fraction of itself behind a paste chip that looks
    // identical to a complete one (see sendTextWithConfirmation) — then the
    // submit Enter as a SEPARATE event. A Claude TUI treats a "text + \r" burst
    // as one paste and absorbs the \r as a newline in the input box instead of
    // submitting; a lone \r a beat later lands as a real Enter keypress.
    // (Harmless for a plain shell — same as typing then pressing return.)
    let landed = true
    let confirmed = false
    let unchecked = skipConfirm
    let detail = 'not checked (--no-confirm)'
    if (rawText.length > 0) {
      if (skipConfirm) {
        await adapter.sendInput(blockId, rawText)
      } else {
        const result = await sendTextWithConfirmation(adapter, blockId, rawText)
        landed = result.landed
        confirmed = result.confirmed
        unchecked = !!result.unchecked
        detail = result.detail
      }
    }

    // A body that did not land must NOT be submitted. Pressing Enter now would
    // send whatever fraction arrived as though it were the whole message, and a
    // truncated brief reads as a complete one to whoever receives it — which is
    // exactly the failure being fixed, with the retry moved one step later.
    if (!landed) {
      adapter.closeSocket()
      consola.error(
        `Delivery to ${blockId.slice(0, 8)} could not be confirmed: ${detail}. NOT submitting — a partial message looks like a whole one. ` +
        `The text is left in the tab's input box for you to inspect (ctrl+u clears it). ` +
        `For anything large, \`cctabs send ${query} --path <file>\` avoids the prompt line entirely.`,
      )
      process.exit(1)
    }

    let resp: unknown
    if (sendEnter) {
      if (rawText.length > 0) await new Promise((r) => setTimeout(r, 200))
      resp = await adapter.sendInput(blockId, '\r')
    }
    adapter.closeSocket()
    if (resp && (resp as Record<string, unknown>).error) {
      consola.error(String((resp as Record<string, unknown>).error)); process.exit(1)
    }

    const preview = rawText.slice(0, 80).replace(/\n/g, '↵').replace(/\t/g, '→')
    const label = rawText.length > 0 ? `${JSON.stringify(preview)}${rawText.length > 80 ? '…' : ''}${sendEnter ? ' ⏎' : ''}` : '⏎'

    // --verify: ask the RECEIVING session what it got. The screen cannot answer
    // this for a collapsed paste (see paste-confirm.ts), and the transcript can
    // — it records the user message as received, so the payload's front and
    // tail are checkable against ground truth.
    if (verify && rawText.length > 0 && sendEnter) {
      const outcome = await verifyDelivered(tabName!, tabCwd!, rawText, verifyTimeoutSec)
      if (!outcome.delivered) {
        consola.error(`Sent to ${blockId.slice(0, 8)}, but delivery does NOT check out: ${outcome.detail}`)
        process.exit(1)
      }
      consola.success(`Sent to ${blockId.slice(0, 8)} and verified: ${outcome.detail}`)
      return
    }
    if (verify && rawText.length > 0 && !sendEnter) {
      consola.warn('--verify has nothing to check without a submit: the message is only recorded once the turn starts.')
    }

    // "Sent", "landed", and "verified to have arrived whole" are three
    // different claims. They used to be one ✔ line, which is how a partial
    // delivery came to look like a success.
    if (rawText.length === 0) {
      // Named, not shown as an empty preview. An empty preview after a ✔ was
      // the tell that a ~900-byte payload had been eaten by the arg parser, so
      // that shape must never appear for anything but a deliberate bare Enter.
      consola.success(`Submitted Enter only (no body) to ${blockId.slice(0, 8)}`)
    } else if (unchecked) {
      consola.info(`Sent to ${blockId.slice(0, 8)} (unconfirmed — ${detail}): ${label}`)
    } else if (!confirmed) {
      consola.warn(`Sent to ${blockId.slice(0, 8)} — arrived, but completeness UNVERIFIED: ${detail}. ${label}`)
    } else {
      consola.success(`Sent to ${blockId.slice(0, 8)}: ${label}`)
    }
  },
})

/**
 * Poll the target's transcript until it records the message, then compare.
 *
 * Everything here retries until the deadline, including finding the session.
 * Resolving it once up front was a real defect: a freshly spawned tab has no
 * transcript on disk for a second or two, so `--verify` failed instantly with
 * "no session resolved for tab" against a tab that was perfectly fine and about
 * to record the message. The title index is dropped each round for the same
 * reason — it is cached per process, and the session we are waiting for is
 * precisely the one that appears after the cache was built.
 *
 * A timeout is reported as a failed verification rather than a pass, because
 * "I could not check" must not read as "it arrived".
 */
async function verifyDelivered(
  tabName: string,
  tabCwd: string,
  payload: string,
  timeoutSec: number,
): Promise<{ delivered: boolean; detail: string }> {
  const deadline = Date.now() + timeoutSec * 1000
  let last = judgeDelivery(payload, null)
  let sawSession = false

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000))

    resetTitleIndexCache()
    const session = resolveTabSession(tabCwd, tabName)
    if (!session) continue
    sawSession = true

    const located = locateTranscriptFile(session.id)
    if (!located) continue

    let messages: string[]
    try {
      messages = readUserMessages(located.file)
    } catch {
      // A transcript being appended to mid-read; try again.
      continue
    }
    last = judgeDelivery(payload, messages)
    if (last.delivered) return last
  }

  if (!sawSession) {
    return {
      delivered: false,
      detail: `no session for tab "${tabName}" in ${tabCwd} appeared within ${timeoutSec}s, so there was no transcript to check`,
    }
  }
  return last
}
