import { define } from 'gunshi'
import { consola } from 'consola'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'
import { requireAdapter } from '../core/adapter.js'
import { listClaudeConfigDirs, originOf } from '../core/config-dirs.js'
import { pathToProjectSlug } from '../core/session.js'
import { resolveIdentity, UNKNOWN_TAB, type WhoamiTab } from '../core/whoami.js'

/**
 * Locate the project directory holding `sessionId`'s transcript.
 *
 * Filenames only — the point of this command is to answer without paying for a
 * transcript scan. Returns the slug (the project dir's own name) plus which
 * config dir it was found in, since that is also the session's Claude account.
 */
function findSessionSlug(sessionId: string): { slug: string; backend?: string; configDir?: string } | null {
  for (const cfg of listClaudeConfigDirs()) {
    if (!existsSync(cfg.projectsRoot)) continue
    let entries: string[]
    try { entries = readdirSync(cfg.projectsRoot) } catch { continue }
    for (const slug of entries) {
      if (existsSync(join(cfg.projectsRoot, slug, `${sessionId}.jsonl`))) {
        return { slug, ...originOf(cfg) }
      }
    }
  }
  return null
}

export const whoamiCommand = define({
  name: 'whoami',
  description: 'Print the name of the cctabs tab this session is running in (or "unknown")',
  args: {
    json: { type: 'boolean', short: 'j', description: 'Emit the full identity as JSON: tab, tab_id, session_id, cwd, worktree, backend, config_dir, color, via.' },
  },
  async run(ctx) {
    const asJson = (ctx.values.json as boolean | undefined) ?? false
    // Claude Code exports this into every session, so a session always knows its
    // own id even when the process-tree walk below can't find its tab.
    const sessionId = process.env.CLAUDE_CODE_SESSION_ID || undefined

    const adapter = requireAdapter()
    const { tabsById, tabNames } = await adapter.getAllData()
    const tabs: WhoamiTab[] = [...tabsById.entries()].flatMap(([tabId, blocks]) => {
      const term = blocks.find((b) => b.view === 'term')
      if (!term) return []
      return [{
        tabId,
        name: tabNames.get(tabId) ?? tabId.slice(0, 8),
        cwd: term.meta?.['cmd:cwd'],
        color: term.color,
      }]
    })

    const located = sessionId ? findSessionSlug(sessionId) : null
    const identity = resolveIdentity({
      sessionId,
      tabs,
      currentTabId: adapter.currentTabId() || undefined,
      sessionSlug: located?.slug,
      slugOf: pathToProjectSlug,
      origin: located ? { backend: located.backend, configDir: located.configDir } : undefined,
    })
    adapter.closeSocket()

    if (asJson) {
      console.log(JSON.stringify({
        tab: identity.tab,
        tab_id: identity.tabId,
        session_id: identity.sessionId,
        cwd: identity.cwd,
        worktree: identity.worktree,
        ...(identity.backend ? { backend: identity.backend } : {}),
        ...(identity.configDir ? { config_dir: identity.configDir } : {}),
        ...(identity.color !== undefined ? { color: identity.color } : {}),
        via: identity.via,
      }, null, 2))
      return
    }

    // Bare name on stdout, so this drops straight into a command substitution
    // the way the shell snippet it replaces did. `unknown` (exit 0, not an
    // error) is a real answer: a session in a plain terminal, over SSH or in CI
    // has no tab, and callers are meant to say so rather than invent a name.
    console.log(identity.tab ?? UNKNOWN_TAB)
    if (!identity.tab && !sessionId) {
      consola.warn('CLAUDE_CODE_SESSION_ID is not set — not running inside a Claude Code session, so only the process-tree match was available.')
    }
  },
})
