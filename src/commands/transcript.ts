import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabTarget } from '../core/tab-target.js'
import { resolveTabSession } from '../core/session.js'
import { classifySessionLookup, explainSessionLookup } from '../core/session-lookup.js'
import {
  countSessionsInDir,
  locateTranscriptFile,
  readAssistantTurns,
  truncateTurn,
  type AssistantTurn,
} from '../core/transcript.js'

const DEFAULT_TURNS = 3

export const transcriptCommand = define({
  name: 'transcript',
  description: "Print what a tab's Claude session has actually SAID — its last assistant messages, read from the transcript rather than the screen. Unlike `scrollback` this works on a tab that is mid-turn (whose screen is just a spinner).",
  args: {
    target: { type: 'positional', description: 'Tab name, tab ID prefix, or block ID prefix' },
    turns: { type: 'number', short: 'n', description: `How many trailing assistant messages to print (default: ${DEFAULT_TURNS})` },
    chars: { type: 'number', description: 'Truncate each message to this many characters (default: no limit)' },
    json: { type: 'boolean', short: 'j', description: 'Emit machine-readable JSON' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    // `[n]` as a bare second positional, matching the documented shape
    // `cctabs transcript <tab> [n]`, with --turns as the explicit form.
    const positionalN = Number(ctx.positionals[2])
    const turnCount =
      (ctx.values.turns as number | undefined) ??
      (Number.isFinite(positionalN) && positionalN > 0 ? positionalN : DEFAULT_TURNS)
    const maxChars = ctx.values.chars as number | undefined
    const asJson = (ctx.values.json as boolean | undefined) ?? false

    if (!query) { consola.error('Usage: cctabs transcript <tab-or-block> [n]'); process.exit(1) }

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const resolved = resolveTabTarget(adapter, query, tabsById, tabNames)
    if (!resolved.ok) {
      adapter.closeSocket()
      consola.error(resolved.message)
      for (const line of resolved.lines ?? []) consola.log(line)
      process.exit(1)
    }
    const { name, cwd, blockId } = resolved.target
    adapter.closeSocket()

    // A block that isn't in a nameable tab has no session we can resolve —
    // resolveTabSession keys on the tab's name, which is what Claude was
    // launched with as `--name`.
    if (!name || !cwd) {
      fail(asJson, blockId, 'no-tab', 'Matched a block, not a named tab — no session to look up. Pass a tab name.')
    }

    let session: ReturnType<typeof resolveTabSession> = null
    let lookupError: Error | undefined
    try {
      session = resolveTabSession(cwd!, name!)
    } catch (err) {
      lookupError = err as Error
    }
    if (!session) {
      // Exactly the distinction `sessions --json` now reports, made by the same
      // code: "looked and found nothing" and "couldn't look" are different
      // answers, and reading the second as the first is how a healthy tab gets
      // written off as dead.
      const lookup = classifySessionLookup({
        cwd: cwd!,
        found: false,
        error: lookupError,
        countInDir: () => countSessionsInDir(cwd!),
      })
      fail(asJson, blockId, lookup.status, `${name}: ${explainSessionLookup(lookup)}`)
    }

    const located = locateTranscriptFile(session!.id)
    if (!located) {
      fail(
        asJson,
        blockId,
        'no-transcript',
        `Session ${session!.id.slice(0, 8)} resolved but its transcript is not on disk under any Claude config dir. This is a broken state, not an idle tab.`,
      )
    }

    let turns: AssistantTurn[]
    try {
      turns = readAssistantTurns(located!.file)
    } catch (err) {
      fail(asJson, blockId, 'unreadable', `Could not read ${located!.file}: ${(err as Error).message}`)
      return
    }
    const shown = turns.slice(-turnCount)

    const origin = located!.backend
      ? ` backend=${located!.backend}`
      : located!.configDir ? ` config_dir=${located!.configDir}` : ''

    if (asJson) {
      console.log(JSON.stringify({
        tab: name,
        block_id: blockId,
        session_id: session!.id,
        cwd,
        transcript: located!.file,
        ...(located!.backend ? { backend: located!.backend } : {}),
        ...(located!.configDir ? { config_dir: located!.configDir } : {}),
        assistant_messages: turns.length,
        turns: shown.map((t) => ({
          timestamp: t.timestamp,
          text: truncateTurn(t.text, maxChars),
        })),
      }, null, 2))
      return
    }

    console.log(`# ${name}  session=${session!.id.slice(0, 8)}  cwd=${cwd}${origin}`)
    console.log(`# ${turns.length} assistant message(s) on record; showing the last ${shown.length}`)
    if (!shown.length) {
      console.log('# (none yet — the session has not answered anything)')
      return
    }
    for (const t of shown) {
      console.log(`\n--- ${t.timestamp ?? 'no timestamp'} ---`)
      console.log(truncateTurn(t.text, maxChars))
    }
  },
})

/**
 * Report a lookup that could not produce a transcript, and exit non-zero.
 *
 * Non-zero because a driver that pipes this into a briefing must not mistake
 * "I could not read this session" for "this session has said nothing" — the
 * whole failure this command exists to prevent is briefing from a false
 * picture. `--json` still gets a parseable object so callers can branch on
 * `reason` rather than on exit code alone.
 */
function fail(asJson: boolean, blockId: string, reason: string, message: string): never {
  if (asJson) {
    console.log(JSON.stringify({ block_id: blockId, reason, error: message }, null, 2))
  } else {
    consola.error(message)
  }
  process.exit(1)
}
