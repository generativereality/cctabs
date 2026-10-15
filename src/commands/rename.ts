import { define } from 'gunshi'
import { consola } from 'consola'
import { readFileSync } from 'fs'
import { requireAdapter } from '../core/adapter.js'
import { resolveTabSession, findSessionFileById, persistSessionTitle, resetTitleIndexCache } from '../core/session.js'
import { readProcessTable, matchTabsToClaude, launchedSessionOf } from '../core/claude-procs.js'
import { locateTranscriptFile } from '../core/transcript.js'
import { sendTextWithConfirmation } from '../core/open-session.js'
import { suspendedTabsIn } from '../core/suspend-ops.js'
import { renameRoute, invalidNameReason, lastCustomTitle } from '../core/rename-plan.js'
import { tabsNamed, nameClashWarning } from '../core/tab-match.js'
import { waitOutDraft, draftPreview } from '../core/draft-guard.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const renameCommand = define({
  name: 'rename',
  description: 'Rename a tab, and the Claude session in it',
  args: {
    tab: { type: 'positional', description: 'Tab name or ID prefix' },
    newName: { type: 'positional', description: 'New name' },
  },
  async run(ctx) {
    const query = ctx.positionals[1]
    const newName = ctx.positionals[2]
    if (!query || !newName) { consola.error('Usage: cctabs rename <tab> <new-name>'); process.exit(1) }
    const bad = invalidNameReason(newName)
    if (bad) { consola.error(`Can't rename to ${JSON.stringify(newName)}: ${bad}.`); process.exit(1) }
    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const matches = adapter.resolveTab(query, tabsById, tabNames)
    if (!matches.length) { consola.error(`No tab matching '${query}'`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${query}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }
    const tabId = matches[0]
    const oldName = tabNames.get(tabId) ?? tabId.slice(0, 8)
    const term = (tabsById.get(tabId) ?? []).find((b) => b.view === 'term')
    const procRows = readProcessTable()

    // A suspended tab's placeholder already holds `claude --resume <id> --name
    // <old>`, and `--name` writes the old title back the moment it wakes. Any
    // rename done here would be undone by the wake, so don't pretend.
    if (suspendedTabsIn(adapter, { tabsById, tabNames }, procRows).has(tabId)) {
      adapter.closeSocket()
      consola.error(`"${oldName}" is suspended: its placeholder relaunches Claude under the old name. Wake it first (\`cctabs wake ${tabId.slice(0, 8)}\`), then rename.`)
      process.exit(1)
    }

    const claude = term && procRows
      ? matchTabsToClaude([{ tabId, name: oldName, shellPid: term.shellPid }], procRows).get(tabId)
      : undefined

    // Which session is this tab? The live Claude's own argv is exact; the tab's
    // name is only a guess, and wrong whenever the tab label and the session's
    // title already differ — which is when a rename is most needed.
    const cwd = term?.meta?.['cmd:cwd'] ?? ''
    let sessionId = claude ? launchedSessionOf(claude.proc) : undefined
    let sessionFile: string | null = null
    try {
      if (sessionId) {
        sessionFile = locateTranscriptFile(sessionId)?.file ?? null
      } else if (cwd) {
        const resolved = resolveTabSession(cwd, oldName)
        if (resolved) {
          sessionId = resolved.id
          sessionFile = findSessionFileById(resolved.id, [resolved.dir, cwd])
        }
      }
    } catch { /* best-effort — the tab still gets relabelled */ }

    // `/rename` is typed into the input box like any send, so it must not land
    // on the end of someone's unsent draft (see core/draft-guard.ts). Checked
    // before anything changes, so a refusal leaves the tab exactly as it was.
    if (claude && term) {
      const guard = await waitOutDraft(adapter, term.blockid, {
        onWaiting: (text, totalMs) => consola.info(`"${oldName}" has an unsent draft (${draftPreview(text)}) — waiting up to ${Math.round(totalMs / 1000)}s for it to clear…`),
      })
      if (!guard.ok) {
        adapter.closeSocket()
        consola.error(`Not renamed: "${oldName}" still has an unsent draft in its input box (${draftPreview(guard.text)}), and \`/rename\` would be appended to it. Try again once it is sent or cleared.`)
        process.exit(1)
      }
    }

    const clash = nameClashWarning(newName, tabsNamed(newName, tabNames, tabId), tabNames)
    if (clash) consola.warn(clash)

    await adapter.renameTab(tabId, newName)
    const route = renameRoute({ claudeRunning: !!claude, sessionFile, newName })

    if (route.kind === 'slash' && term) {
      // Typed like a person would. An unsent draft in the input box would be
      // prefixed to it, which the landed-check below can't tell apart — the
      // command is meant for tabs driven from elsewhere, where that is rare.
      const sent = await sendTextWithConfirmation(adapter, term.blockid, route.text)
      if (!sent.landed) {
        adapter.closeSocket()
        consola.error(`Relabelled the tab, but \`${route.text}\` did not reach Claude's input box (${sent.detail}). Nothing was submitted; the running session still carries "${oldName}" and will restore under it.`)
        process.exit(1)
      }
      await sleep(200)
      await adapter.sendInput(term.blockid, '\r')
      adapter.closeSocket()

      // Claude writes the title as soon as it handles the command — or after
      // the current turn, if one is in flight. Check the transcript, briefly.
      // A tab whose session we couldn't identify (a fresh `--name` launch has no
      // id in its argv) is findable by its NEW name once Claude has written it.
      let recorded = false
      for (let i = 0; i < 10 && !recorded; i++) {
        await sleep(300)
        resetTitleIndexCache() // built by the old-name lookup above; stale by now
        try {
          recorded = sessionFile
            ? lastCustomTitle(readFileSync(sessionFile, 'utf-8')) === newName
            : !!cwd && !!resolveTabSession(cwd, newName)
        } catch { break }
        if (!sessionFile && !cwd) break
      }
      if (recorded) {
        consola.success(`Renamed "${oldName}" → "${newName}" (Claude recorded the new title)`)
      } else {
        consola.success(`Renamed "${oldName}" → "${newName}" (sent \`${route.text}\` to Claude)`)
        consola.info('Not in the transcript yet: Claude applies it when its current turn ends.')
      }
      return
    }

    if (route.kind === 'disk' && sessionFile && sessionId) {
      try {
        persistSessionTitle(sessionFile, sessionId, newName)
        adapter.closeSocket()
        consola.success(`Renamed "${oldName}" → "${newName}" (session title updated on disk)`)
        return
      } catch { /* fall through to the tab-only report */ }
    }

    adapter.closeSocket()
    consola.success(`Renamed "${oldName}" → "${newName}"`)
    consola.info('Note: no on-disk Claude session matched this tab, so `cctabs resume` still keys off the previous name.')
  },
})
