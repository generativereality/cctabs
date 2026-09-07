import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { sendTextWithConfirmation } from '../core/open-session.js'
import { readFileSync } from 'fs'

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    process.stdin.on('data', (c) => chunks.push(c))
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString()))
  })
}

export const sendCommand = define({
  name: 'send',
  description: 'Send input to a tab or block (text arg, --file, or stdin pipe)',
  args: {
    target: { type: 'positional', description: 'Tab name, tab ID prefix, or block ID prefix' },
    file: { type: 'string', short: 'f', description: 'Read text from file' },
    enter: { type: 'boolean', short: 'e', description: 'Append newline after text (default: true)' },
    'wait-for-prompt': { type: 'boolean', short: 'w', description: 'Poll the buffer until a ready prompt is visible before sending — a shell prompt ($, %, >) or a ready Claude TUI (❯ input line / "auto mode" footer). Useful for freshly-spawned tabs.' },
    'wait-timeout': { type: 'number', description: 'Timeout in seconds for --wait-for-prompt (default: 10)' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    // Inline text is the second positional — undeclared to keep it optional
    // (declaring it as a positional makes gunshi require it, breaking --file and stdin)
    const inlineText = ctx.positionals[2]
    const filePath = ctx.values.file as string | undefined
    const appendEnter = (ctx.values.enter as boolean | undefined) ?? true
    const waitForPrompt = (ctx.values['wait-for-prompt'] as boolean | undefined) ?? false
    const waitTimeoutSec = (ctx.values['wait-timeout'] as number | undefined) ?? 10

    if (!query) { consola.error('Usage: cctabs send <tab-or-block> [text]'); process.exit(1) }

    // Resolve text source: inline arg > --file > stdin
    let rawText: string
    if (inlineText !== undefined) {
      rawText = inlineText.replace(/\\n/g, '\r').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
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

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()

    // Try tab resolution first, fall back to block resolution
    const tabMatches = adapter.resolveTab(query, tabsById, tabNames)
    let blockId: string

    if (tabMatches.length === 1) {
      const blocks = (tabsById.get(tabMatches[0]) ?? []).filter((b) => b.view === 'term')
      if (!blocks.length) { consola.error(`Tab "${tabNames.get(tabMatches[0])}" has no terminal block`); process.exit(1) }
      blockId = blocks[0].blockid
    } else if (tabMatches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of tabMatches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    } else {
      // Fall back to block resolution
      const allBlocks = adapter.blocksList()
      const blockMatches = adapter.resolveBlock(query, allBlocks)
      if (!blockMatches.length) { consola.error(`No tab or block matching '${query}' (tabs in workspaces with no open window are not visible — open that workspace first)`); process.exit(1) }
      if (blockMatches.length > 1) {
        consola.error(`Multiple blocks match '${query}':`)
        for (const b of blockMatches) consola.log(`  ${b.blockid}`)
        process.exit(1)
      }
      blockId = blockMatches[0].blockid
    }

    if (waitForPrompt) {
      const deadline = Date.now() + waitTimeoutSec * 1000
      let ready = false
      while (Date.now() < deadline) {
        const tail = adapter.scrollback(blockId, 8)
        const lastLine = tail.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? ''
        const stripped = tail.replace(/\s+/g, '')
        // Ready when we see EITHER a bare shell prompt at end-of-line ($ % >),
        // OR Claude's TUI input line — which starts with ❯ but is usually
        // followed by a "Try …" placeholder, so the glyph is NOT at end-of-line
        // — OR Claude's input footer ("auto mode" / "for agents"). The old
        // end-anchored `/[$%>❯]\s*$/` never matched a ready Claude TUI.
        if (/[$%>]\s*$/.test(lastLine) || /^❯/.test(lastLine) || /automode|foragents/i.test(stripped)) {
          ready = true; break
        }
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!ready) {
        adapter.closeSocket()
        consola.error(`Timed out after ${waitTimeoutSec}s waiting for a ready prompt in ${blockId.slice(0, 8)}`)
        process.exit(1)
      }
    }

    // Send the body — confirming it actually landed and re-sending if not, since
    // text sent into a not-yet-ready input handler can be silently lost, front
    // first (see sendTextWithConfirmation) — then the submit Enter as a
    // SEPARATE event. A Claude TUI treats a "text + \r" burst as one paste and
    // absorbs the \r as a newline in the input box instead of submitting; a lone
    // \r a beat later lands as a real Enter keypress. (Harmless for a plain
    // shell — same as typing then pressing return.) Skip the body send when
    // it's empty (a bare-Enter send).
    let landedOk = true
    if (rawText.length > 0) landedOk = await sendTextWithConfirmation(adapter, blockId, rawText)
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
    if (!landedOk) {
      consola.warn(`Text may not have landed in ${blockId.slice(0, 8)} — its front can be dropped by a not-yet-ready input handler. Check the tab by hand before trusting it arrived.`)
    }
    consola.success(`Sent to ${blockId.slice(0, 8)}: ${label}`)
  },
})
