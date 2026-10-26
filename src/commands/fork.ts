import { codexStatus } from '../core/codex.js'
import { tabAgent } from '../core/tab-agent.js'
import { openCodexSession } from '../core/open-codex.js'
import { define } from 'gunshi'
import { consola } from 'consola'
import { requireAdapter } from '../core/adapter.js'
import { readProcessTable } from '../core/claude-procs.js'
import { liveTabSession, procTabsOf } from '../core/tab-session.js'
import { collectSessionRows } from '../core/session-rows.js'
import { openSession } from '../core/open-session.js'
import { loadConfig, applyPrefix } from '../core/config.js'
import { repoRootOf } from '../core/worktree.js'
import { resolveBackend, resolveBackendName, backendEnvWithMarker, listBackends } from '../core/backends.js'
import { resolveColorPreference, TAB_COLOR_NAMES } from '../core/colors.js'

export const forkCommand = define({
  name: 'fork',
  description: 'Fork the source tab’s conversation into a new tab, preserving Claude or Codex',
  args: {
    tab: { type: 'positional', description: 'Source tab name or ID prefix' },
    name: { type: 'string', short: 'n', description: 'Name for the new tab' },
    model: { type: 'string', short: 'm', description: 'Override the fork’s model.' },
    backend: { type: 'string', short: 'b', description: 'Backend preset. Defaults to the CURRENT session\'s backend if any (via CCTABS_ACTIVE_BACKEND) — pass -b anthropic to force the default back explicitly. Run `cctabs backends` to list.' },
    color: { type: 'string', short: 'c', description: `Tab colour for the fork: ${TAB_COLOR_NAMES.join(', ')} or a hex value like "#0275d8". Defaults to the backend preset's \`color\`, else \`[defaults] color\`.` },
  },
  async run(ctx) {
    const sourceQuery = ctx.positionals[1]
    const customName = ctx.values.name
    if (!sourceQuery) { consola.error('Source tab name is required'); process.exit(1) }

    const config = loadConfig()
    const adapter = requireAdapter()
    const data = await adapter.getAllData()
    const { tabsById, tabNames } = data
    const matches = adapter.resolveTab(sourceQuery, tabsById, tabNames)

    if (!matches.length) { consola.error(`No tab matching '${sourceQuery}' (tabs in workspaces with no open window are not visible — open that workspace first)`); process.exit(1) }
    if (matches.length > 1) {
      consola.error(`Multiple tabs match '${sourceQuery}':`)
      for (const tid of matches) consola.log(`  "${tabNames.get(tid)}"  [${tid.slice(0, 8)}]`)
      process.exit(1)
    }

    const tabId = matches[0]
    const tabName = tabNames.get(tabId) ?? tabId.slice(0, 8)
    // Prefix the freshly-minted fork name so its tab title + `claude --name`
    // (RC name) match this machine's convention. Idempotent, so a default of
    // `<already-prefixed-source>-fork` isn't prefixed twice.
    const newName = applyPrefix(customName ?? `${tabName}-fork`, config.defaults.prefix)
    const termBlocks = (tabsById.get(tabId) ?? []).filter((b) => b.view === 'term')
    if (!termBlocks.length) { consola.error(`Tab "${tabName}" has no terminal block`); process.exit(1) }

    const source = tabAgent(adapter, data, tabId)
    if (source.engine === 'unknown') { consola.error('The source engine is unresolved; no conversation was forked.'); process.exit(1) }
    if (source?.engine === 'codex') {
      if (ctx.values.backend) { consola.error('--backend applies to Claude, not a Codex fork.'); process.exit(1) }
      if (!source.id) { consola.error('Cannot identify the source Codex session unambiguously; no fork was opened.'); process.exit(1) }
      const color = resolveColorPreference(ctx.values.color as string | undefined, undefined, config.defaults.color)
      const newTabId = await openCodexSession({ tabName: newName, dir: source.cwd, forkId: source.id, model: ctx.values.model as string | undefined, afterActive: true, color })
      consola.success(`Forked Codex "${tabName}" → "${newName}" [${newTabId.slice(0, 8)}]`)
      consola.info(`source session: ${source.id}`)
      return
    }

    if (codexStatus(adapter.scrollback(termBlocks[0].blockid, 80)) !== undefined) {
      consola.error('This appears to be Codex, but its session could not be identified; no Claude fork was opened.')
      process.exit(1)
    }

    const explicitBackend = ctx.values.backend as string | undefined
    const backendName = resolveBackendName(explicitBackend)
    let envVars: Record<string, string> | undefined
    let backendColor: string | undefined
    if (backendName) {
      const backend = resolveBackend(backendName)
      if (!backend) {
        consola.error(`Unknown backend "${backendName}". Available:`)
        for (const b of listBackends()) consola.log(`  ${b.name.padEnd(22)} ${b.description}`)
        process.exit(1)
      }
      envVars = backendEnvWithMarker(backendName, backend)
      backendColor = backend.color
    }

    let color: string | null | undefined
    try {
      color = resolveColorPreference(ctx.values.color as string | undefined, backendColor, config.defaults.color)
    } catch (e) {
      consola.error((e as Error).message)
      process.exit(1)
    }
    const inheritedBackend = !explicitBackend && !!backendName
    const be = backendName ? ` [backend: ${backendName}${inheritedBackend ? ' (inherited)' : ''}]` : ''

    // A worktree tab's session lives under the repo root for lookup purposes,
    // and that's also where the fork should open. Shared with `profile-copy`,
    // which needs the same mapping when a worktree has been deleted.
    const rawDir = termBlocks[0].meta?.['cmd:cwd'] ?? process.cwd()
    const sessionLookupDir = repoRootOf(rawDir)
    const openDir = sessionLookupDir

    // The SOURCE TAB's own session, never the newest one in its folder: with
    // several tabs in one repo the newest transcript is usually the caller's,
    // mid-turn running this very fork (rehearsal 2026-10-26: `fork api` opened
    // the lead tab's conversation). Asked of the Claude running in the tab
    // first, then the same per-tab resolution `sessions` reports.
    const procRows = readProcessTable()
    let sessionId = liveTabSession(tabId, procTabsOf(tabsById, tabNames), procRows)?.id
    if (!sessionId) {
      const row = (await collectSessionRows(adapter, procRows)).flatMap((w) => w.sessions).find((r) => r.tab_id === tabId)
      sessionId = row?.session_id ?? undefined
    }
    if (!sessionId) {
      consola.error(`Could not identify the session of "${tabName}"; no fork was opened.`)
      consola.info('cctabs does not guess from the newest session in the folder, which with several tabs there is usually another tab\'s. Check `cctabs sessions`.')
      process.exit(1)
    }

    const newTabId = await openSession({
      tabName: newName,
      dir: openDir,
      // `--name` names the forked RC session to match the new tab (previously a
      // fork left the session unnamed) so it's distinguishable — and prefixed —
      // on claude.ai.
      claudeCmd: `claude --resume ${sessionId} --fork-session --name ${JSON.stringify(newName)}`,
      envVars,
      modelOverride: ctx.values.model as string | undefined,
      afterActive: true,
      color,
    })
    consola.success(`Forked "${tabName}" → "${newName}" [${newTabId.slice(0, 8)}]${be}`)
    consola.info(`session: ${sessionId}`)
  },
})
