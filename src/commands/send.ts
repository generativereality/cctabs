import { define } from 'gunshi'
import { consola } from 'consola'
import { requireWaveAdapter } from '../core/wave.js'
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
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    // Inline text is the second positional — undeclared to keep it optional
    // (declaring it as a positional makes gunshi require it, breaking --file and stdin)
    const inlineText = ctx.positionals[2]
    const filePath = ctx.values.file as string | undefined
    const appendEnter = (ctx.values.enter as boolean | undefined) ?? true

    if (!query) { consola.error('Usage: herd send <tab-or-block> [text]'); process.exit(1) }

    // Resolve text source: inline arg > --file > stdin
    let rawText: string
    if (inlineText !== undefined) {
      rawText = inlineText.replace(/\\n/g, '\r').replace(/\\r/g, '\r').replace(/\\t/g, '\t')
    } else if (filePath) {
      rawText = readFileSync(filePath, 'utf-8').replace(/\n/g, '\r')
    } else {
      rawText = (await readStdin()).replace(/\n/g, '\r')
    }

    if (appendEnter && !rawText.endsWith('\r')) rawText += '\r'

    const adapter = requireWaveAdapter()
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

    const resp = await adapter.sendInput(blockId, rawText)
    adapter.closeSocket()
    if (resp && (resp as Record<string, unknown>).error) {
      consola.error(String((resp as Record<string, unknown>).error)); process.exit(1)
    }
    const preview = rawText.slice(0, 80).replace(/\n/g, '↵').replace(/\t/g, '→')
    consola.success(`Sent to ${blockId.slice(0, 8)}: ${JSON.stringify(preview)}${rawText.length > 80 ? '…' : ''}`)
  },
})
