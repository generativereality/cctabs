import { resolve } from 'path'
import { homedir } from 'os'
import { define } from 'gunshi'
import { consola } from 'consola'
import { loadConfig } from '../core/config.js'
import { requireWaveAdapter } from '../core/wave.js'
import { openSession } from '../core/open-session.js'
import { findSessionsByName } from '../core/session.js'

export const restoreCommand = define({
  name: 'restore',
  description: 'Resume Claude sessions in all terminal-state tabs (e.g. after a reboot)',
  args: {
    dir: { type: 'positional', description: 'Working directory (default: cwd)' },
    dry: { type: 'boolean', short: 'n', description: 'Show what would be resumed without actually doing it' },
  },
  async run(ctx) {
    const dir = resolve((ctx.positionals[1] ?? process.cwd()).replace(/^~/, homedir()))
    const dryRun = ctx.values.dry as boolean | undefined

    const adapter = requireWaveAdapter()
    const { tabsById, workspaces, tabNames } = await adapter.getAllData()
    const currentTab = process.env.WAVETERM_TABID ?? ''

    // Collect all tabs with their status
    const tabs: Array<{
      tabId: string
      name: string
      blockId: string
      status: string
    }> = []

    for (const wsp of workspaces) {
      for (const tabId of wsp.workspacedata.tabids) {
        if (tabId === currentTab) continue // skip the tab running this command
        const blocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
        if (!blocks.length) continue
        const name = tabNames.get(tabId) ?? tabId.slice(0, 8)
        const status = adapter.detectSessionStatus(blocks[0].blockid)
        tabs.push({ tabId, name, blockId: blocks[0].blockid, status })
      }
    }

    const toResume = tabs.filter((t) => t.status === 'terminal' || t.status === 'unknown')
    const alreadyActive = tabs.filter((t) => t.status === 'active' || t.status === 'idle')

    if (alreadyActive.length) {
      consola.info(`Already running: ${alreadyActive.map((t) => t.name).join(', ')}`)
    }

    if (!toResume.length) {
      consola.info('No terminal-state tabs to restore.')
      adapter.closeSocket()
      return
    }

    consola.info(`Found ${toResume.length} tab(s) to restore:`)

    const config = loadConfig()
    const extraFlags = config.claude.flags.join(' ')
    const results: Array<{ name: string; result: string }> = []

    // Collect tabs that need to be recreated (after the socket loop completes)
    const toRecreate: Array<{ name: string; sessionId: string; blockIds: string[]; tabId: string }> = []

    for (const tab of toResume) {
      const sessions = findSessionsByName(dir, tab.name)
      if (sessions.length === 0) {
        consola.log(`  ${tab.name} — no session named "${tab.name}" found, skipping`)
        results.push({ name: tab.name, result: 'no matching session' })
        continue
      }
      if (sessions.length > 1) {
        consola.log(`  ${tab.name} — multiple sessions found, skipping (use cctabs resume --session to pick one)`)
        results.push({ name: tab.name, result: 'ambiguous (multiple sessions)' })
        continue
      }

      const sessionId = sessions[0].id

      if (dryRun) {
        const mode = tab.status === 'unknown' ? 'recreate' : 'send'
        consola.log(`  ${tab.name} → would ${mode} session ${sessionId.slice(0, 8)}…`)
        results.push({ name: tab.name, result: `dry run: ${sessionId.slice(0, 8)}…` })
        continue
      }

      // Dead tab (empty scrollback, typical after Wave restart) — recreate.
      // Can't call openSession here because the adapter socket is in use;
      // defer until we've closed the socket.
      if (tab.status === 'unknown') {
        const stillEmpty = await adapter.confirmScrollbackEmpty(tab.blockId)
        if (stillEmpty) {
          const blockIds = (tabsById.get(tab.tabId) ?? []).map((b) => b.blockid)
          toRecreate.push({ name: tab.name, sessionId, blockIds, tabId: tab.tabId })
          results.push({ name: tab.name, result: 'queued for recreate' })
          continue
        }
      }

      consola.log(`  ${tab.name} → resuming session ${sessionId.slice(0, 8)}… (send)`)
      const cmd = `cd ${JSON.stringify(dir)} && claude${extraFlags ? ' ' + extraFlags : ''} --resume ${sessionId} --name ${JSON.stringify(tab.name)}\r`
      await adapter.sendInput(tab.blockId, cmd)

      // Brief pause between sends to avoid overwhelming Wave
      await new Promise((r) => setTimeout(r, 500))
      results.push({ name: tab.name, result: 'sent' })
    }

    // If not dry run, wait a bit then verify which tabs started
    if (!dryRun) {
      const sent = results.filter((r) => r.result === 'sent')
      if (sent.length) {
        consola.info('Waiting for sessions to start…')
        await new Promise((r) => setTimeout(r, 10_000))

        for (const r of sent) {
          const tab = toResume.find((t) => t.name === r.name)!
          const status = adapter.detectSessionStatus(tab.blockId)
          if (status === 'active' || status === 'idle') {
            r.result = '✔ running'
          } else if (status === 'unknown') {
            r.result = '? scrollback unavailable'
          } else {
            r.result = '✘ may not have started'
          }
        }
      }
    }

    // Recreate dead tabs sequentially (each openSession opens its own socket)
    if (!dryRun && toRecreate.length) {
      // Delete the old blocks first
      for (const t of toRecreate) {
        for (const bid of t.blockIds) adapter.deleteBlock(bid)
      }
      adapter.closeSocket()

      consola.info(`Recreating ${toRecreate.length} dead tab(s)…`)
      for (const t of toRecreate) {
        try {
          const newTabId = await openSession({
            tabName: t.name,
            dir,
            claudeCmd: `claude --resume ${t.sessionId} --name ${JSON.stringify(t.name)}`,
          })
          const r = results.find((x) => x.name === t.name)!
          r.result = `✔ recreated [${newTabId.slice(0, 8)}]`
        } catch (err) {
          const r = results.find((x) => x.name === t.name)!
          r.result = `✘ recreate failed: ${(err as Error).message}`
        }
      }
    } else {
      adapter.closeSocket()
    }

    // Summary
    console.log('\nRestore summary:')
    for (const r of results) {
      console.log(`  ${r.name}: ${r.result}`)
    }
  },
})
