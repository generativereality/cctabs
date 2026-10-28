import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabTarget } from '../core/tab-target.js'
import { markSuggestion } from '../core/input-draft.js'

export const scrollbackCommand = define({
  name: 'scrollback',
  description: 'Show terminal output for a tab or block (default: last 50 lines). This is the last PAINTED FRAME — a tab mid-turn shows a spinner and little else, so use `cctabs transcript` to read what it has actually said. Claude\'s dim prompt suggestion in an empty input box is shown as `⟨suggestion: …⟩`: it is not a typed draft.',
  args: {
    target: { type: 'positional', description: 'Tab name, tab ID prefix, or block ID prefix' },
    // No gunshi `default` here on purpose: a default fills the value in
    // unconditionally, which would make the `[n]` positional below unreachable.
    lines: { type: 'number', description: 'Number of lines to show (default: 50)' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    // `[n]` as a bare second positional, matching the shape the skill documents
    // (`cctabs scrollback <tab> [n]`), which --lines alone never supported.
    const positionalN = Number(ctx.positionals[2])
    const lines =
      (ctx.values.lines as number | undefined) ??
      (Number.isFinite(positionalN) && positionalN > 0 ? positionalN : 50)
    if (!query) { consola.error('Tab name or block ID is required'); process.exit(1) }

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()

    const resolved = resolveTabTarget(adapter, query, tabsById, tabNames)
    if (!resolved.ok) {
      consola.error(resolved.message)
      for (const line of resolved.lines ?? []) consola.log(line)
      process.exit(1)
    }

    const blockId = resolved.target.blockId
    const text = adapter.scrollback(blockId, lines)
    // A prompt suggestion is dim ghost text, but the stream has no dimness, so
    // ask the screen what is really in the box and mark it (input-draft.ts).
    const state = adapter.inputDraft ? await adapter.inputDraft(blockId).catch(() => null) : null
    process.stdout.write(state ? markSuggestion(text, state) : text)
  },
})
